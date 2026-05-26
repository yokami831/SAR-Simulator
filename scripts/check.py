#!/usr/bin/env python3
"""HiyoCanvas integrated check script.

Usage:
    python scripts/check.py [--all | --build | --types | --pytest | --lint | --runtime]
    Default: --all (runs build, types, pytest, lint; skips runtime if server not running)
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

# Project root: scripts/check.py -> project root
PROJECT_ROOT = Path(__file__).resolve().parent.parent
BASELINE_FILE = PROJECT_ROOT / ".check-baseline.json"


def _discover_server_port() -> int:
    """Read the resolved server port from the runtime file, else legacy 18731."""
    runtime_file = PROJECT_ROOT / ".hiyocanvas-runtime.json"
    try:
        if runtime_file.exists():
            data = json.loads(runtime_file.read_text(encoding="utf-8"))
            if data.get("server_port"):
                return int(data["server_port"])
    except Exception:
        pass
    return 18731


SERVER_PORT = _discover_server_port()
HEALTH_URL = f"http://127.0.0.1:{SERVER_PORT}/api/health"
CANVAS_API = PROJECT_ROOT / ".claude" / "skills" / "hiyocanvas" / "scripts" / "canvas_api.py"

# Legacy strings to detect
LEGACY_PATTERNS = [
    (r"radiocanvas", "radiocanvas (should be hiyocanvas)"),
    (r"GNU Radio", "GNU Radio reference"),
]
# Files/dirs to exclude from lint check
LINT_EXCLUDE_DIRS = {".git", "node_modules", ".venv", "venv", "dist", "__pycache__", ".pytest_cache", "archive"}
LINT_EXCLUDE_FILES = {"CLAUDE.md", "PLAN.md", "check.py", "INDEX.md"}
LINT_EXTENSIONS = {".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".html", ".css"}


class CheckResult:
    def __init__(self, name: str):
        self.name = name
        self.status = "SKIP"  # PASS, FAIL, SKIP
        self.message = ""
        self.details: list[str] = []

    def __str__(self) -> str:
        icon = {"PASS": "[PASS]", "FAIL": "[FAIL]", "SKIP": "[SKIP]"}[self.status]
        line = f"{icon} {self.name:<9} — {self.message}"
        if self.details:
            for d in self.details:
                line += f"\n  {d}"
        return line


def _run_cmd(cmd: list[str], cwd: Path | None = None, timeout: int = 120) -> tuple[int, str, str]:
    """Run a command and return (returncode, stdout, stderr)."""
    try:
        proc = subprocess.run(
            cmd, cwd=cwd or PROJECT_ROOT, capture_output=True,
            text=True, timeout=timeout, shell=(os.name == "nt"),
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "Command timed out"
    except FileNotFoundError as e:
        return -1, "", str(e)


def check_build() -> CheckResult:
    """Run Vite build and check for errors."""
    result = CheckResult("build")
    start = time.time()
    rc, stdout, stderr = _run_cmd(["npm", "run", "build"], timeout=180)
    elapsed = time.time() - start

    if rc == 0:
        result.status = "PASS"
        result.message = f"Vite build succeeded ({elapsed:.1f}s)"
    else:
        result.status = "FAIL"
        result.message = f"Vite build failed ({elapsed:.1f}s)"
        # Extract error lines
        for line in (stderr + stdout).splitlines():
            if "error" in line.lower() or "ERROR" in line:
                result.details.append(line.strip())
                if len(result.details) >= 10:
                    break
    return result


def check_types() -> CheckResult:
    """Run TypeScript type checking."""
    result = CheckResult("types")
    rc, stdout, stderr = _run_cmd(["npx", "tsc", "--noEmit"], timeout=120)
    output = stdout + stderr

    # Count errors
    error_lines = [l for l in output.splitlines() if re.search(r"error TS\d+", l)]
    error_count = len(error_lines)

    # Load/save baseline
    baseline = _load_baseline()
    old_count = baseline.get("types_errors")

    if old_count is not None:
        diff = error_count - old_count
        if diff > 0:
            trend = f"(+{diff} from baseline {old_count})"
        elif diff < 0:
            trend = f"({diff} from baseline {old_count})"
        else:
            trend = f"(unchanged from baseline {old_count})"
    else:
        trend = "(baseline recorded)"

    # Save new baseline
    baseline["types_errors"] = error_count
    _save_baseline(baseline)

    result.status = "PASS" if error_count == 0 else "FAIL"
    result.message = f"{error_count} TypeScript errors {trend}"

    if error_count > 0 and error_count <= 5:
        for line in error_lines[:5]:
            result.details.append(line.strip())
    return result


def check_pytest() -> CheckResult:
    """Run pytest tests."""
    result = CheckResult("pytest")
    python = _get_python()
    rc, stdout, stderr = _run_cmd(
        [python, "-m", "pytest", "tests/", "-v", "--tb=short"],
        timeout=120,
    )
    output = stdout + stderr

    # Parse results from last line
    match = re.search(r"(\d+) passed", output)
    passed = int(match.group(1)) if match else 0
    match = re.search(r"(\d+) failed", output)
    failed = int(match.group(1)) if match else 0
    match = re.search(r"(\d+) error", output)
    errors = int(match.group(1)) if match else 0

    if failed == 0 and errors == 0 and passed > 0:
        result.status = "PASS"
        result.message = f"{passed} passed"
    elif failed > 0 or errors > 0:
        result.status = "FAIL"
        result.message = f"{failed} failed, {passed} passed"
        if errors:
            result.message += f", {errors} errors"
        # Extract FAILED lines
        for line in output.splitlines():
            if line.strip().startswith("FAILED"):
                result.details.append(line.strip())
    else:
        result.status = "FAIL"
        result.message = "No tests collected"
    return result


def check_lint() -> CheckResult:
    """Search for legacy strings that should have been removed."""
    result = CheckResult("lint")
    findings: list[str] = []

    for root, dirs, files in os.walk(PROJECT_ROOT):
        # Skip excluded directories
        dirs[:] = [d for d in dirs if d not in LINT_EXCLUDE_DIRS]
        rel_root = Path(root).relative_to(PROJECT_ROOT)

        for fname in files:
            if fname in LINT_EXCLUDE_FILES:
                continue
            fpath = Path(root) / fname
            if fpath.suffix not in LINT_EXTENSIONS:
                continue

            try:
                text = fpath.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue

            for pattern, desc in LEGACY_PATTERNS:
                for match in re.finditer(pattern, text, re.IGNORECASE):
                    line_num = text[:match.start()].count("\n") + 1
                    rel_path = fpath.relative_to(PROJECT_ROOT)
                    findings.append(f"{rel_path}:{line_num}: {desc}")

    if findings:
        result.status = "FAIL"
        result.message = f"{len(findings)} legacy strings found"
        result.details = findings[:20]
        if len(findings) > 20:
            result.details.append(f"... and {len(findings) - 20} more")
    else:
        result.status = "PASS"
        result.message = "No legacy strings found"
    return result


def check_runtime() -> CheckResult:
    """Check for frontend JS errors (requires HiyoCanvas running)."""
    result = CheckResult("runtime")

    # Check if server is running
    try:
        req = urllib.request.Request(HEALTH_URL, method="GET")
        resp = urllib.request.urlopen(req, timeout=3)
        if resp.status != 200:
            result.status = "SKIP"
            result.message = "HiyoCanvas not responding"
            return result
    except (urllib.error.URLError, OSError):
        result.status = "SKIP"
        result.message = "HiyoCanvas not running (use ctl.py start first)"
        return result

    errors_found = []

    # Get frontend errors via canvas_api.py
    python = _get_python()
    if CANVAS_API.exists():
        rc, stdout, stderr = _run_cmd(
            [python, str(CANVAS_API), "get_frontend_errors"],
            timeout=10,
        )
        if rc == 0 and stdout.strip():
            data = _parse_canvas_api_output(stdout)
            if data:
                msg = data.get("message", "")
                # "No errors" means clean; anything else contains error details
                if msg and "No errors" not in msg:
                    # Extract individual error lines from message
                    for line in msg.splitlines():
                        line = line.strip()
                        if line and not line.startswith("Errors"):
                            errors_found.append(f"[JS] {line}")

        # Get console error logs
        rc, stdout, stderr = _run_cmd(
            [python, str(CANVAS_API), "get_console_logs"],
            timeout=10,
        )
        if rc == 0 and stdout.strip():
            data = _parse_canvas_api_output(stdout)
            if data:
                msg = data.get("message", "")
                # Parse log lines, look for ERROR level entries
                for line in msg.splitlines():
                    line = line.strip()
                    if "] ERROR:" in line:
                        errors_found.append(f"[console] {line}")

    if errors_found:
        result.status = "FAIL"
        result.message = f"{len(errors_found)} runtime errors"
        result.details = errors_found
    else:
        result.status = "PASS"
        result.message = "No runtime errors"
    return result


def _parse_canvas_api_output(output: str) -> dict | None:
    """Parse canvas_api.py output format: '[OK] action\\n  {json}'."""
    for line in output.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    return None


def _get_python() -> str:
    """Get the Python executable path."""
    venv_python = PROJECT_ROOT / ".venv" / "Scripts" / "python.exe"
    if venv_python.exists():
        return str(venv_python)
    return sys.executable


def _load_baseline() -> dict:
    """Load the baseline file."""
    if BASELINE_FILE.exists():
        try:
            return json.loads(BASELINE_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _save_baseline(data: dict) -> None:
    """Save the baseline file."""
    BASELINE_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="HiyoCanvas integrated check")
    parser.add_argument("--all", action="store_true", default=True, help="Run all checks (default)")
    parser.add_argument("--build", action="store_true", help="Vite build check")
    parser.add_argument("--types", action="store_true", help="TypeScript type check")
    parser.add_argument("--pytest", action="store_true", help="Run pytest")
    parser.add_argument("--lint", action="store_true", help="Legacy string check")
    parser.add_argument("--runtime", action="store_true", help="Runtime error check")
    args = parser.parse_args()

    # If any specific flag is set, disable --all
    specific = any([args.build, args.types, args.pytest, args.lint, args.runtime])
    if specific:
        args.all = False

    checks = []
    if args.all or args.build:
        checks.append(("build", check_build))
    if args.all or args.types:
        checks.append(("types", check_types))
    if args.all or args.pytest:
        checks.append(("pytest", check_pytest))
    if args.all or args.lint:
        checks.append(("lint", check_lint))
    if args.all or args.runtime:
        checks.append(("runtime", check_runtime))

    print("=== HiyoCanvas Check ===")
    results: list[CheckResult] = []
    for name, fn in checks:
        r = fn()
        results.append(r)
        print(r)

    # Summary
    passed = sum(1 for r in results if r.status == "PASS")
    failed = sum(1 for r in results if r.status == "FAIL")
    skipped = sum(1 for r in results if r.status == "SKIP")
    total = passed + failed

    print()
    parts = []
    if total > 0:
        parts.append(f"{passed}/{total} passed")
    if failed > 0:
        parts.append(f"{failed} failed")
    if skipped > 0:
        parts.append(f"{skipped} skipped")
    print(f"Result: {', '.join(parts)}")

    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    main()
