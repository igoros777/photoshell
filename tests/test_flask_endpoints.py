"""Integration tests for PhotoShell Flask API endpoints."""

import json
import os


class TestIndex:
    def test_index_returns_html(self, client):
        r = client.get("/")
        assert r.status_code == 200
        assert b"PhotoShell" in r.data


class TestBrowse:
    def test_browse_tmp(self, client):
        r = client.get("/api/browse?path=/tmp")
        assert r.status_code == 200
        data = r.get_json()
        assert "current" in data
        assert "dirs" in data

    def test_browse_nonexistent(self, client):
        r = client.get("/api/browse?path=/nonexistent_dir_xyz")
        assert r.status_code in (400, 404)


class TestValidateFolder:
    def test_valid_folder(self, client, photo_dir):
        r = client.get("/api/validate_folder?path=" + photo_dir)
        data = r.get_json()
        assert data["valid"] is True
        assert data["photo_count"] == 3
        assert data["path"] == photo_dir

    def test_empty_folder(self, client, empty_dir):
        r = client.get("/api/validate_folder?path=" + empty_dir)
        data = r.get_json()
        assert data["valid"] is True
        assert data["photo_count"] == 0
        assert "warning" in data

    def test_nonexistent_folder(self, client):
        r = client.get("/api/validate_folder?path=/nonexistent_path_xyz")
        data = r.get_json()
        assert data["valid"] is False

    def test_no_path(self, client):
        r = client.get("/api/validate_folder")
        data = r.get_json()
        assert data["valid"] is False

    def test_subfolders_detected(self, client, photo_dir, tmp_path):
        # Create a subfolder with photos
        sub = tmp_path / "sub1"
        sub.mkdir()
        (sub / "a.jpg").write_bytes(b"\xff" * 50)
        r = client.get("/api/validate_folder?path=" + str(tmp_path))
        data = r.get_json()
        assert data["valid"] is True
        assert "subfolders" in data
        assert len(data["subfolders"]) >= 1


class TestPhotos:
    def test_list_photos(self, client, photo_dir):
        r = client.get("/api/photos?path=" + photo_dir)
        data = r.get_json()
        assert data["total"] == 3
        assert len(data["files"]) == 3
        assert data["page"] == 1

    def test_pagination(self, client, photo_dir):
        r = client.get("/api/photos?path=" + photo_dir + "&per_page=2&page=1")
        data = r.get_json()
        assert len(data["files"]) == 2
        assert data["has_more"] is True

    def test_nonexistent_dir(self, client):
        r = client.get("/api/photos?path=/nonexistent_xyz")
        assert r.status_code in (400, 404)


class TestLog:
    def test_invalid_job(self, client):
        r = client.get("/api/log/nonexistent")
        assert r.status_code == 404

    def test_invalid_status(self, client):
        r = client.get("/api/status/nonexistent")
        assert r.status_code == 404


class TestPresets:
    def test_list_empty(self, client):
        r = client.get("/api/presets")
        data = r.get_json()
        assert "presets" in data

    def test_save_and_load(self, client):
        # Save
        r = client.post("/api/presets",
                        data=json.dumps({"name": "test-preset", "config": {"enable_blur": True}}),
                        content_type="application/json")
        data = r.get_json()
        assert data.get("ok") is True

        # Load
        r = client.get("/api/presets/test-preset")
        data = r.get_json()
        assert data["name"] == "test-preset"
        assert data["config"]["enable_blur"] is True

        # Delete
        r = client.delete("/api/presets/test-preset")
        data = r.get_json()
        assert data.get("ok") is True

        # Verify gone
        r = client.get("/api/presets/test-preset")
        assert r.status_code == 404

    def test_invalid_name(self, client):
        r = client.post("/api/presets",
                        data=json.dumps({"name": "../evil", "config": {}}),
                        content_type="application/json")
        assert r.status_code == 400


class TestUndo:
    def test_check_no_originals(self, client, photo_dir):
        r = client.get("/api/undo/check?path=" + photo_dir)
        data = r.get_json()
        assert data["available"] is False

    def test_check_with_originals(self, client, photo_dir):
        # Create a fake _original file
        orig = os.path.join(photo_dir, "photo1.jpg_original")
        with open(orig, "wb") as f:
            f.write(b"\xff" * 50)
        r = client.get("/api/undo/check?path=" + photo_dir)
        data = r.get_json()
        assert data["available"] is True


class TestBlurResults:
    def test_no_results(self, client, photo_dir):
        r = client.get("/api/blur_results?path=" + photo_dir)
        data = r.get_json()
        assert data["has_results"] is False

    def test_with_analyzed_dir(self, client, photo_dir):
        # Create analyzed/ with scored files
        analyzed = os.path.join(photo_dir, "analyzed")
        os.makedirs(analyzed)
        with open(os.path.join(analyzed, "0847_photo1.jpg"), "wb") as f:
            f.write(b"\xff" * 50)
        r = client.get("/api/blur_results?path=" + photo_dir)
        data = r.get_json()
        assert data["has_results"] is True
        assert len(data["analyzed"]) == 1
        assert data["analyzed"][0]["score"] == 847


class TestGpsData:
    def test_gps_data_endpoint(self, client, photo_dir):
        r = client.get("/api/gps_data?path=" + photo_dir)
        # May fail if exiftool isn't installed, but endpoint should respond
        assert r.status_code in (200, 500)

    def test_no_path(self, client):
        r = client.get("/api/gps_data")
        assert r.status_code == 400


class TestRunEndpoint:
    def test_missing_photo_dir(self, client):
        r = client.post("/api/run",
                        data=json.dumps({}),
                        content_type="application/json")
        assert r.status_code == 400

    def test_no_steps(self, client, photo_dir):
        r = client.post("/api/run",
                        data=json.dumps({"photo_dir": photo_dir}),
                        content_type="application/json")
        data = r.get_json()
        assert "error" in data
