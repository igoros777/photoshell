"""Tests for the structured metadata search module."""

import os
import sys
from unittest import mock

import pytest

# Add the Flask app directory to sys.path so we can import functions.*
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "ui", "flask"))

from functions.structured_search import (
    DEFAULT_FIELDS,
    DATE_FIELDS,
    NUMERIC_FIELDS,
    _classify_field,
    _parse_date,
    apply_filters,
    sample_photo_files,
)


# ---------------------------------------------------------------------------
# Field classification tests
# ---------------------------------------------------------------------------

class TestClassifyField:
    """Test field type classification."""

    def test_numeric_fields(self):
        for field in ("FNumber", "ISO", "FocalLength", "GPSLatitude",
                      "ImageWidth", "ExposureTime"):
            assert _classify_field(field) == "numeric", (
                "%s should be numeric" % field
            )

    def test_date_fields(self):
        for field in ("DateTimeOriginal", "CreateDate", "ModifyDate",
                      "DateCreated", "TimeCreated"):
            assert _classify_field(field) == "date", (
                "%s should be date" % field
            )

    def test_text_fields(self):
        for field in ("Model", "LensModel", "Make", "Software", "Artist"):
            assert _classify_field(field) == "text", (
                "%s should be text" % field
            )

    def test_select_type_determined_by_unique_values(self):
        """Select type is a runtime determination, not a classification.

        _classify_field always returns 'text' for non-numeric/non-date fields.
        The 'select' type is assigned in discover_fields when unique values <= 20.
        """
        assert _classify_field("Model") == "text"


# ---------------------------------------------------------------------------
# Date parsing tests
# ---------------------------------------------------------------------------

class TestParseDate:
    def test_exif_format(self):
        dt = _parse_date("2024:06:15 14:30:00")
        assert dt is not None
        assert dt.year == 2024
        assert dt.month == 6
        assert dt.day == 15
        assert dt.hour == 14

    def test_iso_date(self):
        dt = _parse_date("2024-06-15")
        assert dt is not None
        assert dt.year == 2024

    def test_iso_datetime(self):
        dt = _parse_date("2024-06-15T14:30:00")
        assert dt is not None
        assert dt.hour == 14

    def test_invalid_date(self):
        assert _parse_date("not a date") is None

    def test_none_value(self):
        assert _parse_date(None) is None


# ---------------------------------------------------------------------------
# apply_filters - range operator (numeric)
# ---------------------------------------------------------------------------

class TestApplyFiltersRangeNumeric:
    """Test apply_filters with range operator on numeric fields."""

    @pytest.fixture
    def records(self):
        return [
            {"FileName": "a.jpg", "FNumber": 2.8, "ISO": 100},
            {"FileName": "b.jpg", "FNumber": 5.6, "ISO": 400},
            {"FileName": "c.jpg", "FNumber": 8.0, "ISO": 800},
            {"FileName": "d.jpg", "FNumber": 11.0, "ISO": 1600},
        ]

    def test_range_min_only(self, records):
        filters = [{"field": "FNumber", "op": "range", "min": 5.0}]
        result = apply_filters(records, filters)
        assert len(result) == 3
        fnames = [r["FileName"] for r in result]
        assert "a.jpg" not in fnames

    def test_range_max_only(self, records):
        filters = [{"field": "FNumber", "op": "range", "max": 6.0}]
        result = apply_filters(records, filters)
        assert len(result) == 2
        fnames = [r["FileName"] for r in result]
        assert "a.jpg" in fnames
        assert "b.jpg" in fnames

    def test_range_min_and_max(self, records):
        filters = [{"field": "ISO", "op": "range", "min": 200, "max": 1000}]
        result = apply_filters(records, filters)
        assert len(result) == 2
        fnames = [r["FileName"] for r in result]
        assert "b.jpg" in fnames
        assert "c.jpg" in fnames

    def test_range_no_matches(self, records):
        filters = [{"field": "ISO", "op": "range", "min": 10000}]
        result = apply_filters(records, filters)
        assert len(result) == 0

    def test_range_all_match(self, records):
        filters = [{"field": "FNumber", "op": "range", "min": 1.0, "max": 22.0}]
        result = apply_filters(records, filters)
        assert len(result) == 4


# ---------------------------------------------------------------------------
# apply_filters - range operator (date)
# ---------------------------------------------------------------------------

class TestApplyFiltersRangeDate:
    """Test apply_filters with range operator on date fields."""

    @pytest.fixture
    def records(self):
        return [
            {"FileName": "jan.jpg", "DateTimeOriginal": "2024:01:15 10:00:00"},
            {"FileName": "mar.jpg", "DateTimeOriginal": "2024:03:20 12:00:00"},
            {"FileName": "jun.jpg", "DateTimeOriginal": "2024:06:10 14:00:00"},
            {"FileName": "dec.jpg", "DateTimeOriginal": "2024:12:25 08:00:00"},
        ]

    def test_date_range_min(self, records):
        filters = [{"field": "DateTimeOriginal", "op": "range",
                     "min": "2024:06:01 00:00:00"}]
        result = apply_filters(records, filters)
        assert len(result) == 2
        fnames = [r["FileName"] for r in result]
        assert "jun.jpg" in fnames
        assert "dec.jpg" in fnames

    def test_date_range_max(self, records):
        filters = [{"field": "DateTimeOriginal", "op": "range",
                     "max": "2024:03:31 23:59:59"}]
        result = apply_filters(records, filters)
        assert len(result) == 2
        fnames = [r["FileName"] for r in result]
        assert "jan.jpg" in fnames
        assert "mar.jpg" in fnames

    def test_date_range_min_and_max(self, records):
        filters = [{"field": "DateTimeOriginal", "op": "range",
                     "min": "2024:02:01 00:00:00",
                     "max": "2024:07:01 00:00:00"}]
        result = apply_filters(records, filters)
        assert len(result) == 2
        fnames = [r["FileName"] for r in result]
        assert "mar.jpg" in fnames
        assert "jun.jpg" in fnames

    def test_date_range_with_iso_format(self, records):
        """Filters can use different date format than the record values."""
        filters = [{"field": "DateTimeOriginal", "op": "range",
                     "min": "2024-06-01"}]
        result = apply_filters(records, filters)
        assert len(result) == 2


# ---------------------------------------------------------------------------
# apply_filters - eq operator
# ---------------------------------------------------------------------------

class TestApplyFiltersEq:
    """Test apply_filters with eq (exact match) operator."""

    @pytest.fixture
    def records(self):
        return [
            {"FileName": "a.jpg", "Model": "Canon EOS R5"},
            {"FileName": "b.jpg", "Model": "Nikon Z9"},
            {"FileName": "c.jpg", "Model": "canon eos r5"},
        ]

    def test_eq_case_insensitive(self, records):
        filters = [{"field": "Model", "op": "eq", "value": "Canon EOS R5"}]
        result = apply_filters(records, filters)
        assert len(result) == 2
        fnames = [r["FileName"] for r in result]
        assert "a.jpg" in fnames
        assert "c.jpg" in fnames

    def test_eq_no_match(self, records):
        filters = [{"field": "Model", "op": "eq", "value": "Sony A7IV"}]
        result = apply_filters(records, filters)
        assert len(result) == 0


# ---------------------------------------------------------------------------
# apply_filters - contains operator
# ---------------------------------------------------------------------------

class TestApplyFiltersContains:
    """Test apply_filters with contains (substring) operator."""

    @pytest.fixture
    def records(self):
        return [
            {"FileName": "a.jpg", "Model": "Canon EOS R5"},
            {"FileName": "b.jpg", "Model": "Nikon Z9"},
            {"FileName": "c.jpg", "Model": "Canon EOS R6 Mark II"},
        ]

    def test_contains_substring(self, records):
        filters = [{"field": "Model", "op": "contains", "value": "Canon"}]
        result = apply_filters(records, filters)
        assert len(result) == 2

    def test_contains_case_insensitive(self, records):
        filters = [{"field": "Model", "op": "contains", "value": "canon"}]
        result = apply_filters(records, filters)
        assert len(result) == 2

    def test_contains_no_match(self, records):
        filters = [{"field": "Model", "op": "contains", "value": "Sony"}]
        result = apply_filters(records, filters)
        assert len(result) == 0


# ---------------------------------------------------------------------------
# apply_filters - in operator
# ---------------------------------------------------------------------------

class TestApplyFiltersIn:
    """Test apply_filters with in operator."""

    @pytest.fixture
    def records(self):
        return [
            {"FileName": "a.jpg", "Model": "Canon EOS R5"},
            {"FileName": "b.jpg", "Model": "Nikon Z9"},
            {"FileName": "c.jpg", "Model": "Sony A7IV"},
        ]

    def test_in_matches(self, records):
        filters = [{"field": "Model", "op": "in",
                     "values": ["Canon EOS R5", "Sony A7IV"]}]
        result = apply_filters(records, filters)
        assert len(result) == 2
        fnames = [r["FileName"] for r in result]
        assert "a.jpg" in fnames
        assert "c.jpg" in fnames

    def test_in_case_insensitive(self, records):
        filters = [{"field": "Model", "op": "in",
                     "values": ["canon eos r5"]}]
        result = apply_filters(records, filters)
        assert len(result) == 1


# ---------------------------------------------------------------------------
# apply_filters - missing field
# ---------------------------------------------------------------------------

class TestApplyFiltersMissingField:
    """Test that records with missing fields are excluded."""

    def test_missing_field_excludes_record(self):
        records = [
            {"FileName": "a.jpg", "FNumber": 2.8},
            {"FileName": "b.jpg"},  # no FNumber
        ]
        filters = [{"field": "FNumber", "op": "range", "min": 1.0}]
        result = apply_filters(records, filters)
        assert len(result) == 1
        assert result[0]["FileName"] == "a.jpg"

    def test_all_records_missing_field(self):
        records = [
            {"FileName": "a.jpg"},
            {"FileName": "b.jpg"},
        ]
        filters = [{"field": "ISO", "op": "range", "min": 100}]
        result = apply_filters(records, filters)
        assert len(result) == 0


# ---------------------------------------------------------------------------
# apply_filters - dash value
# ---------------------------------------------------------------------------

class TestApplyFiltersDashValue:
    """Test that records with '-' values are excluded."""

    def test_dash_value_excludes_record(self):
        records = [
            {"FileName": "a.jpg", "FNumber": 2.8},
            {"FileName": "b.jpg", "FNumber": "-"},
        ]
        filters = [{"field": "FNumber", "op": "range", "min": 1.0}]
        result = apply_filters(records, filters)
        assert len(result) == 1
        assert result[0]["FileName"] == "a.jpg"

    def test_none_value_excludes_record(self):
        records = [
            {"FileName": "a.jpg", "FNumber": 2.8},
            {"FileName": "b.jpg", "FNumber": None},
        ]
        filters = [{"field": "FNumber", "op": "range", "min": 1.0}]
        result = apply_filters(records, filters)
        assert len(result) == 1


# ---------------------------------------------------------------------------
# apply_filters - AND logic
# ---------------------------------------------------------------------------

class TestApplyFiltersAndLogic:
    """Test that AND logic requires all filters to pass."""

    @pytest.fixture
    def records(self):
        return [
            {"FileName": "a.jpg", "FNumber": 2.8, "ISO": 100, "Model": "Canon EOS R5"},
            {"FileName": "b.jpg", "FNumber": 5.6, "ISO": 400, "Model": "Canon EOS R5"},
            {"FileName": "c.jpg", "FNumber": 2.8, "ISO": 800, "Model": "Nikon Z9"},
            {"FileName": "d.jpg", "FNumber": 8.0, "ISO": 1600, "Model": "Nikon Z9"},
        ]

    def test_and_all_must_match(self, records):
        filters = [
            {"field": "FNumber", "op": "range", "max": 5.6},
            {"field": "Model", "op": "eq", "value": "Canon EOS R5"},
        ]
        result = apply_filters(records, filters, logic="AND")
        assert len(result) == 2
        fnames = [r["FileName"] for r in result]
        assert "a.jpg" in fnames
        assert "b.jpg" in fnames

    def test_and_stricter_filters(self, records):
        filters = [
            {"field": "FNumber", "op": "range", "max": 3.0},
            {"field": "Model", "op": "eq", "value": "Canon EOS R5"},
            {"field": "ISO", "op": "range", "max": 200},
        ]
        result = apply_filters(records, filters, logic="AND")
        assert len(result) == 1
        assert result[0]["FileName"] == "a.jpg"


# ---------------------------------------------------------------------------
# apply_filters - OR logic
# ---------------------------------------------------------------------------

class TestApplyFiltersOrLogic:
    """Test that OR logic requires any filter to pass."""

    @pytest.fixture
    def records(self):
        return [
            {"FileName": "a.jpg", "FNumber": 2.8, "Model": "Canon EOS R5"},
            {"FileName": "b.jpg", "FNumber": 11.0, "Model": "Nikon Z9"},
            {"FileName": "c.jpg", "FNumber": 8.0, "Model": "Sony A7IV"},
        ]

    def test_or_any_matches(self, records):
        filters = [
            {"field": "FNumber", "op": "range", "max": 4.0},
            {"field": "Model", "op": "eq", "value": "Nikon Z9"},
        ]
        result = apply_filters(records, filters, logic="OR")
        assert len(result) == 2
        fnames = [r["FileName"] for r in result]
        assert "a.jpg" in fnames
        assert "b.jpg" in fnames


# ---------------------------------------------------------------------------
# apply_filters - empty filters
# ---------------------------------------------------------------------------

class TestApplyFiltersEmpty:
    """Test that empty filters return all records."""

    def test_no_filters_returns_all(self):
        records = [
            {"FileName": "a.jpg", "FNumber": 2.8},
            {"FileName": "b.jpg", "FNumber": 5.6},
        ]
        result = apply_filters(records, [])
        assert len(result) == 2


# ---------------------------------------------------------------------------
# apply_filters - non-numeric value in numeric range
# ---------------------------------------------------------------------------

class TestApplyFiltersNonNumeric:
    """Test that non-numeric values in numeric fields fail the filter."""

    def test_non_numeric_value_excluded(self):
        records = [
            {"FileName": "a.jpg", "FNumber": "not a number"},
            {"FileName": "b.jpg", "FNumber": 2.8},
        ]
        filters = [{"field": "FNumber", "op": "range", "min": 1.0}]
        result = apply_filters(records, filters)
        assert len(result) == 1
        assert result[0]["FileName"] == "b.jpg"


class TestApplyFiltersRegex:
    """Test the 'regex' filter operator (PCRE, case-insensitive)."""

    def test_regex_simple_match(self):
        records = [
            {"FileName": "IMG_0001.jpg"},
            {"FileName": "DSC_1234.jpg"},
            {"FileName": "IMG_0099.jpg"},
        ]
        filters = [{"field": "FileName", "op": "regex", "value": "^IMG_"}]
        result = apply_filters(records, filters)
        assert len(result) == 2

    def test_regex_case_insensitive(self):
        records = [
            {"FileName": "img_0001.jpg"},
            {"FileName": "IMG_0002.jpg"},
        ]
        filters = [{"field": "FileName", "op": "regex", "value": "^img_"}]
        result = apply_filters(records, filters)
        assert len(result) == 2

    def test_regex_digit_pattern(self):
        records = [
            {"FileName": "IMG_0001.jpg"},
            {"FileName": "photo.jpg"},
            {"FileName": "IMG_9999.jpg"},
        ]
        filters = [{"field": "FileName", "op": "regex", "value": r"IMG_\d{4}"}]
        result = apply_filters(records, filters)
        assert len(result) == 2

    def test_regex_no_match(self):
        records = [{"FileName": "photo.jpg"}]
        filters = [{"field": "FileName", "op": "regex", "value": "^DSC_"}]
        result = apply_filters(records, filters)
        assert len(result) == 0

    def test_regex_invalid_pattern_returns_no_match(self):
        records = [{"FileName": "test.jpg"}]
        filters = [{"field": "FileName", "op": "regex", "value": "[invalid"}]
        result = apply_filters(records, filters)
        assert len(result) == 0

    def test_regex_empty_pattern_matches_all(self):
        records = [{"FileName": "a.jpg"}, {"FileName": "b.jpg"}]
        filters = [{"field": "FileName", "op": "regex", "value": ""}]
        result = apply_filters(records, filters)
        assert len(result) == 2

    def test_regex_on_caption(self):
        records = [
            {"Caption-Abstract": "Aerial view of mountains at sunset"},
            {"Caption-Abstract": "Close-up of flowers in a garden"},
            {"Caption-Abstract": "Mountain trail with hikers"},
        ]
        filters = [{"field": "Caption-Abstract", "op": "regex", "value": "mountain"}]
        result = apply_filters(records, filters)
        assert len(result) == 2


class TestApplyFiltersKeywordsAll:
    """Test the 'keywords_all' filter (space-separated, all must match, regex)."""

    def test_single_term_matches(self):
        records = [
            {"Keywords": ["mountain", "sunset", "landscape"]},
            {"Keywords": ["ocean", "beach"]},
        ]
        filters = [{"field": "Keywords", "op": "keywords_all", "value": "mount"}]
        result = apply_filters(records, filters)
        assert len(result) == 1

    def test_all_terms_must_match(self):
        records = [
            {"Keywords": ["mountain", "sunset", "landscape"]},
            {"Keywords": ["mountain", "river"]},
        ]
        filters = [{"field": "Keywords", "op": "keywords_all", "value": "mount sunset"}]
        result = apply_filters(records, filters)
        assert len(result) == 1

    def test_term_not_found_excludes(self):
        records = [{"Keywords": ["mountain", "sunset"]}]
        filters = [{"field": "Keywords", "op": "keywords_all", "value": "mount ocean"}]
        result = apply_filters(records, filters)
        assert len(result) == 0

    def test_regex_terms(self):
        records = [
            {"Keywords": ["mountain vista", "golden hour", "landscape"]},
            {"Keywords": ["city skyline", "night"]},
        ]
        filters = [{"field": "Keywords", "op": "keywords_all", "value": r"mount.*vista golden"}]
        result = apply_filters(records, filters)
        assert len(result) == 1

    def test_keywords_as_string(self):
        records = [{"Keywords": "mountain, sunset, landscape"}]
        filters = [{"field": "Keywords", "op": "keywords_all", "value": "mount land"}]
        result = apply_filters(records, filters)
        assert len(result) == 1

    def test_empty_value_matches_all(self):
        records = [{"Keywords": ["a"]}, {"Keywords": ["b"]}]
        filters = [{"field": "Keywords", "op": "keywords_all", "value": ""}]
        result = apply_filters(records, filters)
        assert len(result) == 2

    def test_invalid_regex_term_excludes(self):
        records = [{"Keywords": ["test"]}]
        filters = [{"field": "Keywords", "op": "keywords_all", "value": "[bad"}]
        result = apply_filters(records, filters)
        assert len(result) == 0


# ---------------------------------------------------------------------------
# sample_photo_files
# ---------------------------------------------------------------------------

class TestSamplePhotoFiles:
    """Test the sample_photo_files function with mocked filesystem."""

    @mock.patch("functions.structured_search._list_all_photo_files")
    def test_small_directory_returns_all(self, mock_list):
        mock_list.return_value = ["/photos/a.jpg", "/photos/b.jpg", "/photos/c.jpg"]
        sampled, total = sample_photo_files("/photos", sample_size=10)
        assert total == 3
        assert len(sampled) == 3

    @mock.patch("functions.structured_search._list_all_photo_files")
    def test_exact_sample_size(self, mock_list):
        files = ["/photos/%02d.jpg" % i for i in range(10)]
        mock_list.return_value = files
        sampled, total = sample_photo_files("/photos", sample_size=10)
        assert total == 10
        assert len(sampled) == 10

    @mock.patch("functions.structured_search._list_all_photo_files")
    def test_large_directory_samples_to_limit(self, mock_list):
        files = ["/photos/%04d.jpg" % i for i in range(100)]
        mock_list.return_value = files
        sampled, total = sample_photo_files("/photos", sample_size=10)
        assert total == 100
        assert len(sampled) <= 10

    @mock.patch("functions.structured_search._list_all_photo_files")
    def test_stratified_includes_all_extensions(self, mock_list):
        """Every file extension type should be represented in the sample."""
        files = (
            ["/photos/img_%04d.jpg" % i for i in range(50)] +
            ["/photos/raw_%04d.nef" % i for i in range(30)] +
            ["/photos/tif_%04d.tiff" % i for i in range(20)]
        )
        mock_list.return_value = files
        sampled, total = sample_photo_files("/photos", sample_size=15)
        assert total == 100
        assert len(sampled) <= 15
        # All three extensions should be represented
        exts = set(os.path.splitext(f)[1] for f in sampled)
        assert ".jpg" in exts
        assert ".nef" in exts
        assert ".tiff" in exts

    @mock.patch("functions.structured_search._list_all_photo_files")
    def test_single_rare_extension_included(self, mock_list):
        """Even a single file with a unique extension should be sampled."""
        files = (
            ["/photos/img_%04d.jpg" % i for i in range(99)] +
            ["/photos/pano.dng"]
        )
        mock_list.return_value = files
        sampled, total = sample_photo_files("/photos", sample_size=10)
        assert total == 100
        assert "/photos/pano.dng" in sampled

    @mock.patch("functions.structured_search._list_all_photo_files")
    def test_empty_directory(self, mock_list):
        mock_list.return_value = []
        sampled, total = sample_photo_files("/photos", sample_size=10)
        assert total == 0
        assert len(sampled) == 0

    @mock.patch("functions.structured_search._list_all_photo_files")
    def test_recursive_flag_passed(self, mock_list):
        mock_list.return_value = ["/photos/sub/a.jpg"]
        sampled, total = sample_photo_files("/photos", recursive=True, sample_size=10)
        mock_list.assert_called_once_with("/photos", recursive=True)
        assert total == 1

    @mock.patch("functions.structured_search._list_all_photo_files")
    def test_seven_files_with_sample_size_ten(self, mock_list):
        """When total < sample_size, return all without sampling."""
        files = ["/photos/%d.jpg" % i for i in range(7)]
        mock_list.return_value = files
        sampled, total = sample_photo_files("/photos", sample_size=10)
        assert total == 7
        assert len(sampled) == 7

    @mock.patch("functions.structured_search._list_all_photo_files")
    def test_evenly_spaced_within_extension(self, mock_list):
        """Samples should be evenly spaced, not clustered at start/end."""
        files = ["/photos/%04d.jpg" % i for i in range(100)]
        mock_list.return_value = files
        sampled, total = sample_photo_files("/photos", sample_size=10)
        sorted_sampled = sorted(sampled)
        # First and last should be included (evenly spaced starts at 0)
        assert sorted_sampled[0] == "/photos/0000.jpg"
        assert sorted_sampled[-1] == "/photos/0099.jpg"
