from stockagent.health import Health


def test_problem_alerts_once_and_recovery_once():
    h = Health()
    assert h.problem("opend", "OpenD not logged in") is not None
    assert h.problem("opend", "OpenD not logged in") is None
    assert h.snapshot() == ["opend: OpenD not logged in"]
    assert h.resolved("opend") is not None
    assert h.resolved("opend") is None
    assert h.snapshot() == []


def test_independent_keys():
    h = Health()
    assert h.problem("a", "x") and h.problem("b", "y")
