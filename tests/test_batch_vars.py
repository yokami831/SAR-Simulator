"""Test batch variable expansion ($N and ${N} syntax)."""

import re

# Copy of the regex and function from tools.py
_VAR_RE = re.compile(r"\$\{(\d+)\}|\$(\d+)")


def _resolve_variables(params: dict, variables: dict[int, str]) -> dict:
    def _replace_match(m: re.Match) -> str:
        idx = int(m.group(1) if m.group(1) is not None else m.group(2))
        return variables.get(idx, m.group(0))

    resolved = {}
    for key, value in params.items():
        if isinstance(value, str):
            resolved[key] = _VAR_RE.sub(_replace_match, value)
        elif isinstance(value, dict):
            resolved[key] = _resolve_variables(value, variables)
        else:
            resolved[key] = value
    return resolved


def test_single_digit():
    v = {0: "n1", 1: "n2", 2: "n3"}
    assert _resolve_variables({"source": "$0"}, v) == {"source": "n1"}
    assert _resolve_variables({"target": "$1"}, v) == {"target": "n2"}
    assert _resolve_variables({"target": "$2"}, v) == {"target": "n3"}


def test_two_digit_not_confused():
    """$10 must resolve to index 10, NOT $1 + '0'."""
    v = {1: "n2", 10: "n11"}
    result = _resolve_variables({"source": "$10"}, v)
    assert result == {"source": "n11"}, f"Got {result}, expected n11"


def test_brace_syntax():
    v = {0: "n1", 10: "n11"}
    assert _resolve_variables({"source": "${0}"}, v) == {"source": "n1"}
    assert _resolve_variables({"source": "${10}"}, v) == {"source": "n11"}


def test_unknown_variable_kept():
    v = {0: "n1"}
    assert _resolve_variables({"source": "$99"}, v) == {"source": "$99"}
    assert _resolve_variables({"source": "${99}"}, v) == {"source": "${99}"}


def test_nested_dict():
    v = {0: "n1", 1: "n2"}
    result = _resolve_variables({"outer": {"inner": "$0"}}, v)
    assert result == {"outer": {"inner": "n1"}}


def test_non_string_passthrough():
    v = {0: "n1"}
    result = _resolve_variables({"x": 42, "y": True, "z": None}, v)
    assert result == {"x": 42, "y": True, "z": None}


def test_multiple_refs_in_one_string():
    """Edge case: multiple variable refs in a single string value."""
    v = {0: "n1", 1: "n2"}
    result = _resolve_variables({"cmd": "$0 to $1"}, v)
    assert result == {"cmd": "n1 to n2"}


def test_mixed_brace_and_bare():
    v = {0: "n1", 10: "n11"}
    result = _resolve_variables({"a": "${0}", "b": "$10"}, v)
    assert result == {"a": "n1", "b": "n11"}


if __name__ == "__main__":
    test_single_digit()
    test_two_digit_not_confused()
    test_brace_syntax()
    test_unknown_variable_kept()
    test_nested_dict()
    test_non_string_passthrough()
    test_multiple_refs_in_one_string()
    test_mixed_brace_and_bare()
    print("All tests passed!")
