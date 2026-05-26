"""Take a screenshot of the current screen (or HiyoCanvas window)."""

import sys
from pathlib import Path

from PIL import ImageGrab

# Auto-detect project root from script location (5 levels up)
_PROJECT_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_OUTPUT = str(_PROJECT_ROOT / "tmp_screenshot.png")


def main() -> None:
    output = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUTPUT
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    img = ImageGrab.grab()
    img.save(str(output_path))
    print(f"Saved: {output_path} ({img.width}x{img.height})")


if __name__ == "__main__":
    main()
