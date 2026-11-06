#!/usr/bin/env python3
"""Mocked tests for two-pass event analysis and the vision request adapter."""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

PROJECT_PYTHON = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_PYTHON))

import media_analysis as ma  # noqa: E402


BASE_ENV = {
    "AVE_VISION_BASE_URL": "http://127.0.0.1:11434",
    "AVE_VISION_MODEL": "qwen3-vl:2b",
    "AVE_VISION_API_STYLE": "ollama",
    "AVE_VISION_EVENT_NUM_CTX": "8192",
    "AVE_VISION_NUM_CTX": "8192",
}


def frame_at(timestamp: float) -> dict:
    return {"ok": True, "sourceTimeSeconds": round(timestamp, 3), "thumbnailPath": "frame.jpg"}


def candidate(start: float, end: float, evidence_time: float) -> dict:
    return {
        "startTime": start,
        "endTime": end,
        "description": "A visible event.",
        "category": "action",
        "confidence": 0.7,
        "evidence": [{"sourceTimeSeconds": evidence_time, "observation": "Motion in frame."}],
    }


def refined_event(start: float, end: float, evidence_time: float) -> dict:
    return {
        "event": {
            "startTime": start,
            "endTime": end,
            "description": "The event refined across denser frames.",
            "confidence": 0.8,
            "boundaryPrecision": "exact",
            "uncertaintySeconds": 0.2,
            "evidence": [{"sourceTimeSeconds": evidence_time, "observation": "Refined motion."}],
            "progression": "before -> during -> after",
        }
    }


class AnalyzeEventsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.env = mock.patch.dict(os.environ, BASE_ENV, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.metadata = {"path": "video.mp4", "durationSeconds": 100.0}
        self.probe = mock.patch.object(ma, "probe_media", return_value=self.metadata)
        self.preflight = mock.patch.object(
            ma,
            "_vision_preflight",
            return_value={
                "apiStyle": "ollama",
                "endpoint": "http://127.0.0.1:11434/api/tags",
                "configuredModel": "qwen3-vl:2b",
                "availableModels": ["qwen3-vl:2b"],
            },
        )
        self.scenes = mock.patch.object(
            ma,
            "detect_scenes",
            return_value={"count": 2, "scenes": [{"startSeconds": 0.0}, {"startSeconds": 40.0}]},
        )
        self.sample_calls: list[list[float]] = []
        self.sample = mock.patch.object(ma, "sample_frames", side_effect=self._fake_sample_frames)
        self.allocation = mock.patch.object(
            ma,
            "_ollama_allocation",
            side_effect=lambda *args, **kwargs: [
                {"model": "qwen3-vl:2b", "sizeBytes": 2800000000, "vramBytes": 2800000000, "cpuPercent": 0.0}
            ],
        )
        for patcher in (self.probe, self.preflight, self.scenes, self.sample, self.allocation):
            patcher.start()
            self.addCleanup(patcher.stop)

    def _fake_sample_frames(self, payload: dict) -> dict:
        timestamps = list(payload.get("timestampsSeconds", []))
        self.sample_calls.append(timestamps)
        return {"frames": [frame_at(timestamp) for timestamp in timestamps]}

    def _vision_fake(self, *, pass2_response=None, pass1_response=None):
        def fake(base_url, model, api_key, task, frames, stats=None, schema_hint=None, num_ctx_override=None, **kwargs):
            if stats is not None:
                stats["requests"] = int(stats.get("requests", 0)) + 1
                stats["inferenceMs"] = int(stats.get("inferenceMs", 0)) + 25
                stats["actualModel"] = model
            times = [frame["sourceTimeSeconds"] for frame in frames]
            if schema_hint and "candidates" in schema_hint:
                if pass1_response is not None:
                    return pass1_response(frames, times)
                return {"candidates": [candidate(times[0] - 1.0, times[0] + 3.0, times[0])]}
            if schema_hint and "event" in schema_hint:
                if pass2_response is not None:
                    return pass2_response(frames, times)
                return refined_event(times[0] - 0.5, times[0] + 1.5, times[0])
            raise AssertionError(f"Unexpected schema hint: {schema_hint}")

        return fake

    def _analyze(self, vision_fake, **payload):
        overrides = {
            "path": "video.mp4",
            "task": "Find notable events.",
            "pass1MaxFrames": 4,
            "pass2FramesPerEvent": 4,
            "maxEvents": 1,
            "maxRequests": 10,
            "visionBatchSize": 4,
            "detectScenes": True,
        }
        overrides.update(payload)
        with mock.patch.object(ma, "_vision_request", side_effect=vision_fake):
            return ma.analyze_events(overrides)

    def test_pass1_candidates_and_pass2_refinement(self) -> None:
        result = self._analyze(self._vision_fake())

        self.assertEqual(result["eventCount"], 1)
        self.assertEqual(result["candidateCount"], 1)
        event = result["events"][0]
        self.assertEqual(event["refinement"], "pass1+pass2")
        self.assertEqual(event["category"], "action")
        self.assertAlmostEqual(event["confidence"], 0.8)
        self.assertEqual(event["progression"], "before -> during -> after")
        self.assertIn("refined", event["description"].lower())
        self.assertEqual(result["passes"]["pass1"]["sampledFrames"], 4)
        self.assertEqual(result["passes"]["pass1"]["candidatesReported"], 1)
        self.assertEqual(result["passes"]["pass1"]["candidatesValidated"], 1)
        self.assertEqual(result["passes"]["pass1"]["candidatesSelected"], 1)
        self.assertEqual(result["passes"]["pass2"]["reports"][0]["status"], "refined")

    def test_timestamps_and_evidence_preserved_from_frame_mapping(self) -> None:
        def pass1(frames, times):
            return {
                "candidates": [{
                    "startTime": 20.0,
                    "endTime": 30.0,
                    "description": "Valid and invalid evidence.",
                    "category": "movement",
                    "confidence": 0.6,
                    "evidence": [
                        {"sourceTimeSeconds": times[0], "observation": "Valid frame."},
                        {"sourceTimeSeconds": 999.0, "observation": "Invented timestamp."},
                    ],
                }]
            }

        result = self._analyze(self._vision_fake(pass1_response=pass1))
        event = result["events"][0]
        evidence_times = [item["sourceTimeSeconds"] for item in event["evidence"]]
        sampled_times = [timestamp for call in self.sample_calls for timestamp in call]
        self.assertIn(result["passes"]["pass1"]["sampledTimestamps"][0], evidence_times)
        self.assertNotIn(999.0, evidence_times)
        for item in event["evidence"]:
            self.assertAlmostEqual(item["sourceTimeSeconds"], round(item["sourceTimeSeconds"], 3))
            self.assertIn(item["sourceTimeSeconds"], sampled_times)

    def test_schema_validation_clamps_and_rejects_invalid_candidates(self) -> None:
        candidates = ma._validated_candidates(
            {
                "candidates": [
                    {
                        "startTime": 40.0,
                        "endTime": 30.0,
                        "description": "Swapped bounds.",
                        "category": "not-a-category",
                        "confidence": 1.5,
                        "evidence": [],
                    },
                    {"startTime": 10.0, "endTime": 12.0, "description": ""},
                    {"startTime": "bad", "endTime": 5.0, "description": "Bad start."},
                    {
                        "startTime": 60.0,
                        "endTime": 60.1,
                        "description": "Tiny span.",
                        "category": "other",
                        "confidence": None,
                    },
                ]
            },
            valid_times=[],
            duration=100.0,
        )
        self.assertEqual(len(candidates), 2)
        first, second = candidates
        self.assertEqual((first["startTime"], first["endTime"]), (30.0, 40.0))
        self.assertEqual(first["category"], "other")
        self.assertAlmostEqual(first["confidence"], 1.0)
        self.assertGreaterEqual(second["endTime"] - second["startTime"], 0.5)
        self.assertIsNone(second["confidence"])

    def test_candidates_with_known_confidence_rank_before_unknown(self) -> None:
        candidates = [
            {"candidateId": "c1", "startTime": 0.0, "endTime": 1.0, "confidence": None},
            {"candidateId": "c2", "startTime": 5.0, "endTime": 6.0, "confidence": 0.4},
            {"candidateId": "c3", "startTime": 9.0, "endTime": 10.0, "confidence": 0.9},
        ]
        ranked = ma._rank_candidates(candidates, 3)
        self.assertEqual([item["candidateId"] for item in ranked], ["c3", "c2", "c1"])

    def test_provenance_separates_vision_ffprobe_scenes_and_audio(self) -> None:
        result = self._analyze(self._vision_fake())
        provenance = result["provenance"]
        self.assertEqual(provenance["vision"]["provider"], "ollama")
        self.assertEqual(provenance["vision"]["configuredModel"], "qwen3-vl:2b")
        self.assertEqual(provenance["vision"]["actualModel"], "qwen3-vl:2b")
        self.assertEqual(provenance["vision"]["status"], "complete")
        self.assertEqual(provenance["vision"]["requests"], 3)
        self.assertEqual(provenance["vision"]["inferenceMs"], 75)
        self.assertEqual(provenance["ffprobe"]["status"], "complete")
        self.assertEqual(provenance["sceneDetection"]["status"], "complete")
        self.assertEqual(provenance["audioAnalysis"]["status"], "not-requested")
        self.assertEqual(provenance["manualObservations"], [])
        self.assertEqual(result["actualModel"], "qwen3-vl:2b")
        self.assertEqual(provenance["vision"]["allocationSampledAfterEachRequest"], True)
        self.assertEqual(provenance["vision"]["sequentialRequests"], True)
        self.assertEqual(provenance["vision"]["maxCpuOffloadPercent"], 20.0)

    def test_missing_confidence_falls_back_to_pass1_event(self) -> None:
        def pass1(frames, times):
            item = candidate(times[0] - 1.0, times[0] + 2.0, times[0])
            item["confidence"] = None
            return {"candidates": [item]}

        result = self._analyze(self._vision_fake(pass1_response=pass1, pass2_response=lambda f, t: {}))
        event = result["events"][0]
        self.assertEqual(event["refinement"], "pass1-only")
        self.assertIsNone(event["confidence"])
        self.assertEqual(event["confidenceSource"], "unavailable")
        self.assertEqual(event["boundary_precision"], "uncertain")
        self.assertEqual(event["uncertaintySource"], "frame-spacing")
        self.assertEqual(result["passes"]["pass2"]["reports"][0]["status"], "no-usable-refinement")

    def test_invalid_model_response_yields_no_fabricated_events(self) -> None:
        result = self._analyze(self._vision_fake(pass1_response=lambda f, t: {"unexpected": []}))
        self.assertEqual(result["events"], [])
        self.assertEqual(result["eventCount"], 0)
        self.assertEqual(result["candidateCount"], 0)
        self.assertEqual(result["passes"]["pass1"]["candidatesReported"], 0)

    def test_empty_vision_response_is_an_error_not_success(self) -> None:
        error = ma.MediaAnalysisError("VISION_INVALID_RESPONSE", "empty content")

        def fail(*args, **kwargs):
            raise error

        with self.assertRaises(ma.MediaAnalysisError) as caught:
            self._analyze(fail)
        self.assertEqual(caught.exception.code, "VISION_INVALID_RESPONSE")

    def test_model_unavailable_preflight_is_an_error(self) -> None:
        self.preflight.stop()
        self.addCleanup(self.preflight.start)
        with mock.patch.object(
            ma,
            "_vision_preflight",
            side_effect=ma.MediaAnalysisError("VISION_MODEL_UNAVAILABLE", "model missing"),
        ):
            with self.assertRaises(ma.MediaAnalysisError) as caught:
                self._analyze(self._vision_fake())
        self.assertEqual(caught.exception.code, "VISION_MODEL_UNAVAILABLE")

    def test_request_budget_skips_pass2(self) -> None:
        result = self._analyze(
            self._vision_fake(),
            pass1MaxFrames=8,
            maxEvents=2,
            maxRequests=1,
        )
        self.assertEqual(result["provenance"]["vision"]["requests"], 1)
        statuses = [report["status"] for report in result["passes"]["pass2"]["reports"]]
        self.assertEqual(statuses, ["skipped-request-budget"])
        self.assertEqual(result["events"][0]["refinement"], "pass1-only")

    def _multi_image_failure_fake(self):
        def fake(base_url, model, api_key, task, frames, stats=None, schema_hint=None, num_ctx_override=None, **kwargs):
            times = [frame["sourceTimeSeconds"] for frame in frames]
            if len(frames) > 1:
                raise ma.MediaAnalysisError(
                    "VISION_INVALID_RESPONSE",
                    "Multi-image request returned empty content.",
                )
            if stats is not None:
                stats["requests"] = int(stats.get("requests", 0)) + 1
                stats["inferenceMs"] = int(stats.get("inferenceMs", 0)) + 10
                stats["actualModel"] = model
            if schema_hint and "candidates" in schema_hint:
                return {"candidates": [candidate(times[0] - 1.0, times[0] + 2.0, times[0])]}
            return refined_event(times[0] - 0.4, times[0] + 1.2, times[0])

        return fake

    def test_failed_multi_image_batch_falls_back_to_single_frames(self) -> None:
        result = self._analyze(
            self._multi_image_failure_fake(),
            maxRequests=20,
            visionBatchSize=4,
        )
        self.assertEqual(result["eventCount"], 1)
        self.assertEqual(result["passes"]["batchSize"], 4)
        pass1_fallback = result["passes"]["pass1"]["fallbacks"][0]
        self.assertEqual(pass1_fallback["status"], "fallback-sequential")
        self.assertEqual(pass1_fallback["requestedFrames"], 4)
        self.assertEqual(pass1_fallback["singleResponses"], 4)
        self.assertEqual(pass1_fallback["errorCode"], "VISION_INVALID_RESPONSE")
        pass2_report = result["passes"]["pass2"]["reports"][0]
        self.assertEqual(pass2_report["status"], "refined")
        self.assertEqual(len(pass2_report["fallbacks"]), 2)
        self.assertGreaterEqual(result["provenance"]["vision"]["fallbackCount"], 3)
        event = result["events"][0]
        sampled = [timestamp for call in self.sample_calls for timestamp in call]
        for item in event["evidence"]:
            self.assertIn(item["sourceTimeSeconds"], sampled)

    def test_fallback_failure_is_not_reported_as_success(self) -> None:
        def fake(base_url, model, api_key, task, frames, stats=None, schema_hint=None, num_ctx_override=None, **kwargs):
            raise ma.MediaAnalysisError("VISION_INVALID_RESPONSE", "Every request returned empty content.")

        with self.assertRaises(ma.MediaAnalysisError) as caught:
            self._analyze(fake, maxRequests=10, visionBatchSize=4)
        self.assertEqual(caught.exception.code, "VISION_INVALID_RESPONSE")

    def test_single_image_batch_mode_never_sends_multi_image_requests(self) -> None:
        seen_sizes: list[int] = []

        def fake(base_url, model, api_key, task, frames, stats=None, schema_hint=None, num_ctx_override=None, **kwargs):
            seen_sizes.append(len(frames))
            times = [frame["sourceTimeSeconds"] for frame in frames]
            if stats is not None:
                stats["requests"] = int(stats.get("requests", 0)) + 1
                stats["actualModel"] = model
            if schema_hint and "candidates" in schema_hint:
                return {"candidates": [candidate(times[0] - 1.0, times[0] + 2.0, times[0])]}
            return refined_event(times[0] - 0.4, times[0] + 1.2, times[0])

        result = self._analyze(fake, maxRequests=20, visionBatchSize=1)
        self.assertTrue(seen_sizes)
        self.assertTrue(all(size == 1 for size in seen_sizes))
        self.assertEqual(result["passes"]["batchSize"], 1)
        self.assertEqual(result["passes"]["pass1"]["fallbacks"], [])
        self.assertEqual(result["provenance"]["vision"]["fallbackCount"], 0)

    def test_warmup_and_gpu_allocation_in_provenance(self) -> None:
        with mock.patch.object(
            ma, "_vision_warmup", return_value={"status": "complete", "durationMs": 5}
        ):
            result = self._analyze(self._vision_fake())
        vision = result["provenance"]["vision"]
        self.assertEqual(vision["warmup"]["status"], "complete")
        self.assertEqual(vision["numCtx"], 8192)
        self.assertEqual(len(vision["gpuAllocation"]), 1)
        self.assertEqual(vision["gpuAllocation"][0]["cpuPercent"], 0.0)

    def test_deadline_returns_pass1_events_with_honest_warning(self) -> None:
        fake_time = [100.0, 101.0, 102.0, 103.0, 104.0, 60000.0]
        env = dict(os.environ)
        env["AVE_ANALYSIS_DEADLINE_SECONDS"] = "60"
        env["AVE_VISION_WARMUP"] = "false"
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.object(ma.time, "time", side_effect=lambda: fake_time.pop(0) if fake_time else 99999.0):
            result = self._analyze(self._vision_fake())
        self.assertEqual(result["events"][0]["refinement"], "pass1-only")
        statuses = [report["status"] for report in result["passes"]["pass2"]["reports"]]
        self.assertEqual(statuses, ["skipped-deadline"])
        self.assertTrue(any("stopped deadline" in warning for warning in result["warnings"]))

    def test_cancel_file_stops_before_pass1_with_clear_error(self) -> None:
        handle = tempfile.NamedTemporaryFile(delete=False)
        handle.close()
        self.addCleanup(lambda: Path(handle.name).unlink(missing_ok=True))
        env = dict(os.environ)
        env["AVE_ANALYSIS_CANCEL_PATH"] = handle.name
        with mock.patch.dict(os.environ, env, clear=False):
            with self.assertRaises(ma.MediaAnalysisError) as caught:
                self._analyze(self._vision_fake())
        self.assertEqual(caught.exception.code, "ANALYSIS_STOPPED")
        self.assertIn("cancelled", str(caught.exception.details))

    def test_job_id_is_echoed_in_result(self) -> None:
        result = self._analyze(self._vision_fake(), jobId="job-123")
        self.assertEqual(result["jobId"], "job-123")

    def test_job_id_rejects_path_separators(self) -> None:
        with self.assertRaises(ma.MediaAnalysisError) as caught:
            self._analyze(self._vision_fake(), jobId="../escape")
        self.assertEqual(caught.exception.code, "INVALID_JOB_ID")

    def test_measured_cpu_offload_above_20_percent_aborts_before_inference(self) -> None:
        env = dict(os.environ)
        env["AVE_VISION_WARMUP"] = "false"
        env["AVE_VISION_MAX_CPU_OFFLOAD_PERCENT"] = "20"
        allocation = [{
            "model": "qwen3-vl:2b", "sizeBytes": 100, "vramBytes": 79.8,
            "gpuPercent": 79.8, "cpuPercent": 20.2, "source": "ollama-api-ps",
        }]
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.object(ma, "_ollama_allocation", return_value=allocation), \
                mock.patch.object(ma, "_vision_request") as request:
            with self.assertRaises(ma.MediaAnalysisError) as caught:
                ma.analyze_events({"path": "video.mp4", "pass1MaxFrames": 4})
        self.assertEqual(caught.exception.code, "VISION_GPU_OFFLOAD_LIMIT")
        self.assertEqual(caught.exception.details["cpuOffloadPercent"], 20.2)
        self.assertEqual(caught.exception.details["maxCpuOffloadPercent"], 20.0)
        request.assert_not_called()

    def test_cancel_is_checked_between_sequential_http_requests(self) -> None:
        frames = [frame_at(1.0), frame_at(2.0), frame_at(3.0)]
        requests: list[float] = []
        stop_checks = 0

        def stop_check() -> str | None:
            nonlocal stop_checks
            stop_checks += 1
            return "cancelled" if stop_checks == 2 else None

        def request(_url, _model, _key, _task, request_frames, stats, _schema, _ctx):
            requests.extend(frame["sourceTimeSeconds"] for frame in request_frames)
            stats["requests"] += 1
            return {"candidates": []}

        with self.assertRaises(ma.MediaAnalysisError) as caught:
            ma._vision_response_batches(
                BASE_ENV["AVE_VISION_BASE_URL"], BASE_ENV["AVE_VISION_MODEL"], None,
                "Find events.", frames, {"requests": 0}, '{"candidates":[]}',
                2048, 1, 8, request_fn=request, stop_check=stop_check,
            )
        self.assertEqual(caught.exception.code, "ANALYSIS_STOPPED")
        self.assertEqual(requests, [1.0])

    def test_event_fallback_provenance_and_response_logs_at_http_boundary(self) -> None:
        image_handle = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
        image_handle.write(b"mocked-image-bytes")
        image_handle.close()
        self.addCleanup(lambda: Path(image_handle.name).unlink(missing_ok=True))
        cache_dir = Path(tempfile.mkdtemp(prefix="event-http-boundary-"))
        self.addCleanup(lambda: shutil.rmtree(cache_dir, ignore_errors=True))
        env = dict(os.environ)
        env.update({
            "AVE_VISION_WARMUP": "false",
            "AVE_VISION_MAX_RETRIES": "1",
            "AVE_VISION_NUM_PREDICT": "128",
            "AVE_VISION_KEEP_ALIVE": "45m",
            "AVE_ANALYSIS_CACHE_DIR": str(cache_dir),
            "AVE_VISION_REQUEST_LOG": "1",
        })
        post_bodies: list[dict] = []

        class ServerErrorStub:
            def read(self, *args) -> bytes:
                return b'{"error":"temporary model failure"}'

            def close(self) -> None:
                return None

        def fake_urlopen(request, timeout=None):
            if request.get_method() == "GET":
                self.assertTrue(request.full_url.endswith("/api/ps"))
                return FakeHttpResponse({"models": [{"name": "qwen3-vl:2b", "size": 100, "size_vram": 100}]})
            body = json.loads(request.data.decode("utf-8"))
            post_bodies.append(body)
            image_count = len(body["messages"][0]["images"])
            if image_count > 1:
                raise urllib.error.HTTPError(
                    request.full_url, 500, "Internal Server Error", {}, ServerErrorStub()
                )
            return FakeHttpResponse({
                "model": "qwen3-vl:2b",
                "done_reason": "stop",
                "prompt_eval_count": 300,
                "eval_count": 24,
                "message": {"content": '{"candidates":[]}'}
            })

        def fake_sample(payload):
            timestamps = list(payload["timestampsSeconds"])
            self.sample_calls.append(timestamps)
            return {"frames": [
                {**frame_at(timestamp), "thumbnailPath": image_handle.name}
                for timestamp in timestamps
            ]}

        self.allocation.stop()
        self.addCleanup(self.allocation.start)
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.object(ma, "sample_frames", side_effect=fake_sample), \
                mock.patch.object(ma.urllib.request, "urlopen", side_effect=fake_urlopen):
            result = ma.analyze_events({
                "path": "video.mp4", "jobId": "http-boundary-job", "pass1MaxFrames": 4,
                "maxEvents": 1, "maxRequests": 20, "visionBatchSize": 4,
            })

        vision = result["provenance"]["vision"]
        self.assertEqual(result["jobId"], "http-boundary-job")
        self.assertEqual(vision["status"], "complete")
        self.assertEqual(vision["requests"], 6)
        self.assertEqual(vision["fallbackCount"], 1)
        fallback = result["passes"]["pass1"]["fallbacks"][0]
        self.assertEqual(fallback["status"], "fallback-sequential")
        self.assertEqual(fallback["singleResponses"], 4)
        self.assertEqual(fallback["errorCode"], "VISION_REQUEST_REJECTED")
        self.assertEqual(len(post_bodies), 6)
        self.assertTrue(all(body["keep_alive"] == "45m" for body in post_bodies))
        log_lines = Path(vision["requestLogPath"]).read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(log_lines), 6)
        log_rows = [json.loads(line) for line in log_lines]
        self.assertTrue(all(row["jobId"] == "http-boundary-job" for row in log_rows))
        self.assertIn("temporary model failure", log_rows[0]["errorDetail"])
        self.assertTrue(all(isinstance(row.get("prompt"), str) for row in log_rows))
        self.assertEqual(log_rows[2]["frameTimestampsSeconds"], [self.sample_calls[0][0]])
        self.assertIn(
            f"Image 1 = {self.sample_calls[0][0]:.3f} seconds",
            log_rows[2]["prompt"],
        )
        self.assertIn("candidates", log_rows[-1]["responseContent"])


class TruncatedJsonRepairTests(unittest.TestCase):
    def test_repairs_truncated_object_with_open_string(self) -> None:
        self.assertEqual(
            ma._repair_truncated_json('{"candidates":[{"description":"cut o'),
            {"candidates": [{"description": "cut o"}]},
        )

    def test_repairs_dangling_colon_by_chopping_partial_value(self) -> None:
        self.assertEqual(ma._repair_truncated_json('{"a": "b", "c":'), {"a": "b"})

    def test_repairs_truncated_array(self) -> None:
        self.assertEqual(ma._repair_truncated_json('[{"a":1},{'), [{"a": 1}])

    def test_returns_none_for_non_json_text(self) -> None:
        self.assertIsNone(ma._repair_truncated_json("The model wrote prose about frames."))

    def test_returns_none_for_impossible_fragment(self) -> None:
        self.assertIsNone(ma._repair_truncated_json('{"a": [}'))

    def test_strips_markdown_fences_before_repair(self) -> None:
        fenced = "```json\n{\"candidates\":[{\"description\":\"Content shown in frame\"}\n```"
        self.assertEqual(
            ma._repair_truncated_json(fenced),
            {"candidates": [{"description": "Content shown in frame"}]},
        )

    def test_parses_complete_fenced_json(self) -> None:
        fenced = "```json\n{\"candidates\":[]}\n```"
        self.assertEqual(ma._repair_truncated_json(fenced), {"candidates": []})


class CandidateValidationTests(unittest.TestCase):
    def test_repeated_candidates_are_deduplicated(self) -> None:
        repeated = {
            "candidates": [
                {"startTime": 5.0, "endTime": 8.0, "description": "Zombie encounter",
                 "category": "encounter", "confidence": 0.8,
                 "evidence": [{"sourceTimeSeconds": 5.0, "observation": "zombie"}]},
                {"startTime": 5.0, "endTime": 8.0, "description": "zombie encounter",
                 "category": "encounter", "confidence": 0.8,
                 "evidence": [{"sourceTimeSeconds": 5.0, "observation": "zombie"}]},
                {"startTime": 20.0, "endTime": 22.0, "description": "Glass breaks",
                 "category": "destruction", "confidence": 0.5,
                 "evidence": [{"sourceTimeSeconds": 20.0, "observation": "glass"}]},
            ]
        }
        candidates = ma._validated_candidates(repeated, [5.0, 20.0], 60.0)
        self.assertEqual(len(candidates), 2)
        self.assertEqual([candidate["description"] for candidate in candidates],
                         ["Zombie encounter", "Glass breaks"])


class FakeHttpResponse:


    def __init__(self, payload: dict) -> None:
        self.payload = payload

    def __enter__(self) -> "FakeHttpResponse":
        return self

    def __exit__(self, *args) -> bool:
        return False

    def read(self, _limit: int | None = None) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


class VisionRequestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.env = mock.patch.dict(os.environ, BASE_ENV, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.sleep = mock.patch.object(ma.time, "sleep", return_value=None)
        self.sleep.start()
        self.addCleanup(self.sleep.stop)
        handle = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
        handle.write(b"not-a-real-jpeg")
        handle.close()
        self.thumbnail = handle.name
        self.addCleanup(lambda: Path(self.thumbnail).unlink(missing_ok=True))
        self.frames = [{"ok": True, "sourceTimeSeconds": 1.0, "thumbnailPath": self.thumbnail}]

    def _run(self, responses: list[dict]) -> tuple[dict, list[dict]]:
        bodies: list[dict] = []

        def fake_urlopen(request, timeout=None):
            bodies.append(json.loads(request.data.decode("utf-8")))
            return FakeHttpResponse(responses[min(len(bodies) - 1, len(responses) - 1)])

        with mock.patch.object(ma.urllib.request, "urlopen", side_effect=fake_urlopen):
            result = ma._vision_request(
                BASE_ENV["AVE_VISION_BASE_URL"],
                BASE_ENV["AVE_VISION_MODEL"],
                None,
                "Find events.",
                self.frames,
                {},
                'Output shape: {"candidates":[]}',
            )
        return result, bodies

    def test_empty_content_retries_with_larger_prediction_budget(self) -> None:
        valid = {"message": {"content": json.dumps({"candidates": []})}, "model": "qwen3-vl:2b"}
        empty = {"message": {"content": ""}, "model": "qwen3-vl:2b"}
        result, bodies = self._run([empty, valid])

        self.assertEqual(result, {"candidates": []})
        self.assertEqual(len(bodies), 2)
        self.assertGreaterEqual(bodies[1]["options"]["num_predict"], 2048)
        self.assertTrue(bodies[0]["messages"][0]["content"].startswith("/no_think"))
        self.assertEqual(bodies[0]["options"]["num_ctx"], 8192)

    def test_persistent_empty_content_raises(self) -> None:
        empty = {"message": {"content": ""}, "model": "qwen3-vl:2b"}
        with self.assertRaises(ma.MediaAnalysisError) as caught:
            self._run([empty, empty, empty])
        self.assertEqual(caught.exception.code, "VISION_INVALID_RESPONSE")

    def test_repeat_limit_retries_with_higher_penalty_and_smaller_budget(self) -> None:
        valid = {"message": {"content": json.dumps({"candidates": []})}, "model": "qwen3-vl:2b"}
        bodies: list[dict] = []

        class RepeatErrorStub:
            def read(self, *args) -> bytes:
                return json.dumps({"error": "prediction aborted, token repeat limit reached"}).encode("utf-8")

            def close(self) -> None:
                return None

        def fake_urlopen(request, timeout=None):
            bodies.append(json.loads(request.data.decode("utf-8")))
            if len(bodies) == 1:
                raise urllib.error.HTTPError(
                    "http://127.0.0.1:11434/api/chat", 500, "Internal Server Error", {}, RepeatErrorStub()
                )
            return FakeHttpResponse(valid)

        with mock.patch.object(ma.urllib.request, "urlopen", side_effect=fake_urlopen):
            result = ma._vision_request(
                BASE_ENV["AVE_VISION_BASE_URL"],
                BASE_ENV["AVE_VISION_MODEL"],
                None,
                "Find events.",
                self.frames,
                {},
                'Output shape: {"candidates":[]}',
            )
        self.assertEqual(result, {"candidates": []})
        self.assertEqual(len(bodies), 2)
        self.assertGreater(bodies[1]["options"]["repeat_penalty"], bodies[0]["options"]["repeat_penalty"])
        self.assertLessEqual(bodies[1]["options"]["num_predict"], 2048)

    def test_repeat_penalty_is_sent_to_ollama(self) -> None:
        valid = {"message": {"content": json.dumps({"candidates": []})}, "model": "qwen3-vl:2b"}
        _result, bodies = self._run([valid])
        self.assertEqual(bodies[0]["options"]["repeat_penalty"], 1.1)
        self.assertEqual(bodies[0]["options"]["repeat_last_n"], 256)

    def test_configured_keep_alive_is_sent_to_ollama(self) -> None:
        env = dict(os.environ)
        env["AVE_VISION_KEEP_ALIVE"] = "12m"
        with mock.patch.dict(os.environ, env, clear=False):
            _result, bodies = self._run([
                {"message": {"content": json.dumps({"candidates": []})}, "model": "qwen3-vl:2b"}
            ])
        self.assertEqual(bodies[0]["keep_alive"], "12m")

    def test_length_terminated_valid_json_retries_with_a_larger_budget(self) -> None:
        bodies: list[dict] = []
        timeouts: list[float] = []
        responses = [
            {"message": {"content": '{"candidates":[]}'}, "model": "qwen3-vl:2b", "done_reason": "length"},
            {"message": {"content": '{"candidates":[]}'}, "model": "qwen3-vl:2b", "done_reason": "stop"},
        ]

        def fake_urlopen(request, timeout=None):
            bodies.append(json.loads(request.data.decode("utf-8")))
            timeouts.append(timeout)
            return FakeHttpResponse(responses[min(len(bodies) - 1, len(responses) - 1)])

        env = dict(os.environ)
        env["AVE_VISION_REQUEST_TIMEOUT_SECONDS"] = "17"
        env["AVE_VISION_MAX_RETRIES"] = "2"
        stats: dict = {}
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.object(ma.urllib.request, "urlopen", side_effect=fake_urlopen), \
                mock.patch.object(ma.time, "sleep", return_value=None):
            result = ma._vision_request(
                BASE_ENV["AVE_VISION_BASE_URL"], BASE_ENV["AVE_VISION_MODEL"], None,
                "Find events.", self.frames, stats, 'Output shape: {"candidates":[]}',
            )
        self.assertEqual(result, {"candidates": []})
        self.assertEqual([body["options"]["num_predict"] for body in bodies], [2048, 4096])
        self.assertEqual(timeouts, [17, 17])
        self.assertEqual(stats["truncatedResponses"], 1)
        self.assertEqual(stats["lastParse"]["doneReason"], "stop")

    def test_vision_request_timeout_retries_within_configured_limit(self) -> None:
        bodies: list[dict] = []
        timeouts: list[float] = []
        valid = {"message": {"content": '{"candidates":[]}'}, "model": "qwen3-vl:2b", "done_reason": "stop"}

        def fake_urlopen(request, timeout=None):
            bodies.append(json.loads(request.data.decode("utf-8")))
            timeouts.append(timeout)
            if len(bodies) == 1:
                raise TimeoutError("request timed out")
            return FakeHttpResponse(valid)

        env = dict(os.environ)
        env["AVE_VISION_REQUEST_TIMEOUT_SECONDS"] = "17"
        env["AVE_VISION_MAX_RETRIES"] = "1"
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.object(ma.urllib.request, "urlopen", side_effect=fake_urlopen), \
                mock.patch.object(ma.time, "sleep", return_value=None):
            result = ma._vision_request(
                BASE_ENV["AVE_VISION_BASE_URL"], BASE_ENV["AVE_VISION_MODEL"], None,
                "Find events.", self.frames, {}, 'Output shape: {"candidates":[]}',
            )
        self.assertEqual(result, {"candidates": []})
        self.assertEqual(len(bodies), 2)
        self.assertEqual(timeouts, [17, 17])

    def test_malformed_json_raises_after_retries(self) -> None:
        malformed = {"message": {"content": "not json"}}
        with self.assertRaises(ma.MediaAnalysisError) as caught:
            self._run([malformed, malformed, malformed])
        self.assertEqual(caught.exception.code, "VISION_INVALID_RESPONSE")

    def test_truncated_json_is_retried_with_larger_output_budget_then_repaired(self) -> None:
        truncated = {
            "message": {"content": '{"candidates":[{"description":"Dialog box","evidence":[{"sourceTimeSeconds":1.0,'},
            "model": "qwen3-vl:2b",
        }
        result, bodies = self._run([truncated])

        self.assertEqual(
            result,
            {"candidates": [{"description": "Dialog box", "evidence": [{"sourceTimeSeconds": 1.0}]}]},
        )
        self.assertEqual(len(bodies), 3)
        self.assertEqual([body["options"]["num_predict"] for body in bodies], [2048, 4096, 8192])

    def test_truncated_json_inside_string_value_is_retried_then_repaired(self) -> None:
        truncated = {
            "message": {"content": '{"candidates":[{"description":"A long description that was cut o'},
            "model": "qwen3-vl:2b",
        }
        result, bodies = self._run([truncated])

        self.assertEqual(result, {"candidates": [{"description": "A long description that was cut o"}]})
        self.assertEqual(len(bodies), 3)


    def test_context_override_is_applied(self) -> None:
        valid = {"message": {"content": json.dumps({"event": {}})}, "model": "qwen3-vl:2b"}
        bodies: list[dict] = []

        def fake_urlopen(request, timeout=None):
            bodies.append(json.loads(request.data.decode("utf-8")))
            return FakeHttpResponse(valid)

        with mock.patch.object(ma.urllib.request, "urlopen", side_effect=fake_urlopen):
            ma._vision_request(
                BASE_ENV["AVE_VISION_BASE_URL"],
                BASE_ENV["AVE_VISION_MODEL"],
                None,
                "Refine.",
                self.frames,
                {},
                'Output shape: {"event":{}}',
                4096,
            )
        self.assertEqual(bodies[0]["options"]["num_ctx"], 4096)

    def test_ollama_allocation_uses_api_ps_and_reports_gpu_cpu_percentages(self) -> None:
        def fake_urlopen(request, timeout=None):
            self.assertTrue(request.full_url.endswith("/api/ps"))
            self.assertEqual(request.get_method(), "GET")
            return FakeHttpResponse({"models": [{"name": "qwen3-vl:2b", "size": 100, "size_vram": 68}]})

        with mock.patch.object(ma.urllib.request, "urlopen", side_effect=fake_urlopen):
            allocation = ma._ollama_allocation(BASE_ENV["AVE_VISION_BASE_URL"], None)
        self.assertEqual(allocation, [{
            "model": "qwen3-vl:2b", "sizeBytes": 100, "vramBytes": 68,
            "gpuPercent": 68.0, "cpuPercent": 32.0, "source": "ollama-api-ps",
        }])

    def test_context_overflow_400_is_classified_without_cpu_risking_context_escalation(self) -> None:
        bodies: list[dict] = []

        class OverflowErrorStub:
            def __init__(self) -> None:
                self.payload = json.dumps({"error": "Requested context exceeds limit"}).encode("utf-8")

            def read(self, *args) -> bytes:
                return self.payload

            def close(self) -> None:
                return None

            def __enter__(self) -> "OverflowErrorStub":
                return self

            def __exit__(self, *args) -> bool:
                return False

        def fake_urlopen(request, timeout=None):
            bodies.append(json.loads(request.data.decode("utf-8")))
            raise urllib.error.HTTPError(
                "http://127.0.0.1:11434/api/chat", 400, "Bad Request", {}, OverflowErrorStub()
            )

        with mock.patch.object(ma.urllib.request, "urlopen", side_effect=fake_urlopen):
            with self.assertRaises(ma.MediaAnalysisError) as caught:
                ma._vision_request(
                    BASE_ENV["AVE_VISION_BASE_URL"], BASE_ENV["AVE_VISION_MODEL"], None,
                    "Find events.",
                    self.frames + [{"ok": True, "sourceTimeSeconds": 2.0, "thumbnailPath": self.thumbnail}],
                    {}, 'Output shape: {"candidates":[]}',
                )
        self.assertEqual(caught.exception.code, "VISION_CONTEXT_OVERFLOW")
        self.assertEqual(len(bodies), 1)
        self.assertEqual(bodies[0]["options"]["num_ctx"], 8192)

    def test_request_log_records_raw_response(self) -> None:
        log_path = Path(tempfile.gettempdir()) / "vision-request-log-test.jsonl"
        if log_path.exists():
            log_path.unlink()
        env = dict(os.environ)
        env["AVE_VISION_REQUEST_LOG_PATH"] = str(log_path)
        env["AVE_VISION_REQUEST_LOG"] = "1"
        with mock.patch.dict(os.environ, env, clear=False):
            valid = {"message": {"content": json.dumps({"candidates": []}), "done": "x"}, "model": "qwen3-vl:2b", "done_reason": "stop", "eval_count": 33}
            self._run([valid])
        entries = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertTrue(entries)
        final = [entry for entry in entries if entry.get("outcome") == "parsed"]
        self.assertEqual(len(final), 1)
        self.assertEqual(final[0]["model"], "qwen3-vl:2b")
        self.assertEqual(final[0]["doneReason"], "stop")
        self.assertEqual(final[0]["evalTokens"], 33)
        self.assertIn("candidates", final[0]["contentSample"])
        self.assertIn("candidates", final[0]["responseContent"])
        self.assertFalse(final[0].get("parseRecovered", False))
        log_path.unlink(missing_ok=True)

    def test_recovered_parse_is_flagged_in_stats(self) -> None:
        truncated = {
            "message": {"content": '{"candidates":[{"description":"Dialog box","evidence":[{"sourceTimeSeconds":1.0,'},
            "model": "qwen3-vl:2b",
        }
        stats: dict = {}
        def fake_urlopen(request, timeout=None):
            return FakeHttpResponse(truncated)

        with mock.patch.object(ma.urllib.request, "urlopen", side_effect=fake_urlopen):
            ma._vision_request(
                BASE_ENV["AVE_VISION_BASE_URL"],
                BASE_ENV["AVE_VISION_MODEL"],
                None,
                "Find events.",
                self.frames,
                stats,
                'Output shape: {"candidates":[]}',
            )
        self.assertIsNotNone(stats.get("lastParse"))
        self.assertTrue(stats["lastParse"]["recovered"])
        self.assertEqual(stats["lastParse"]["outcome"], "truncated-final")
        self.assertTrue(stats["lastParse"]["truncated"])
        self.assertEqual(stats["finalTruncatedResponses"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)

