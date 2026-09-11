import pytest

from app.coverage import CoverageError, assert_coverage, count_buckets


def test_ties_when_the_four_buckets_sum_to_total() -> None:
    assert_coverage(8, 6, 1, 1, 0)
    assert_coverage(0, 0, 0, 0, 0)


def test_a_shortfall_raises_and_names_it() -> None:
    with pytest.raises(CoverageError) as e:
        assert_coverage(8, 6, 0, 1, 0)
    assert "8 fields" in str(e.value)
    assert "= 7" in str(e.value)
    assert "1 unaccounted" in str(e.value)


def test_an_overcount_raises_too() -> None:
    with pytest.raises(CoverageError, match="1 over-counted"):
        assert_coverage(8, 6, 1, 1, 1)


def test_count_buckets_puts_human_sourced_values_in_corrected_whatever_their_state() -> None:
    counted = count_buckets(
        [("read", "text"), ("read", "human"), ("uncertain", "human"), ("uncertain", "ocr"), ("not_found", "text")]
    )
    assert counted == {"total": 5, "read": 1, "corrected": 2, "uncertain": 1, "not_found": 1}
    assert_coverage(**counted)
