#!/usr/bin/env python3
"""Report the Python media-analysis environment as JSON.

This script intentionally uses only the standard library so it can run before
any virtual environment or third-party package is installed.
"""

from __future__ import annotations

import datetime
import importlib.metadata
import importlib.util
import json
import platform
import shutil
import site
import sys
from typing import Any


MODULES = [
    "pip",
    "numpy",
    "cv2",
    "scipy",
    "PIL",
    "scenedetect",
    "faster_whisper",
    "whisper",
    "imageio_ffmpeg",
    "torch",
]


def module_info(name: str) -> dict[str, Any]:
    specification = importlib.util.find_spec(name)
    installed = specification is not None
    version: str | None = None
    if installed:
        distribution_names = {
            "cv2": "opencv-python",
            "PIL": "Pillow",
            "faster_whisper": "faster-whisper",
            "imageio_ffmpeg": "imageio-ffmpeg",
        }
        distribution = distribution_names.get(name, name)
        try:
            version = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            version = None
    return {
        "name": name,
        "installed": installed,
        "version": version,
    }


def main() -> int:
    modules = [module_info(name) for name in MODULES]
    missing = [entry["name"] for entry in modules if not entry["installed"]]

    ffmpeg_available = shutil.which("ffmpeg") is not None
    imageio_ffmpeg_available = any(
        entry["name"] == "imageio_ffmpeg" and entry["installed"]
        for entry in modules
    )

    report = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "python": {
            "executable": sys.executable,
            "version": sys.version,
            "versionInfo": list(sys.version_info[:3]),
            "prefix": sys.prefix,
            "sitePackages": site.getsitepackages(),
            "platform": platform.platform(),
            "machine": platform.machine(),
        },
        "tools": {
            "ffmpeg": shutil.which("ffmpeg"),
            "ffprobe": shutil.which("ffprobe"),
        },
        "modules": modules,
        "missingModules": missing,
        "assessment": {
            "baseWorkerReady": True,
            "ffmpegAvailable": ffmpeg_available,
            "imageioFfmpegAvailable": imageio_ffmpeg_available,
            "notes": [
                "Milestone 1 requires no third-party Python packages.",
                "FFmpeg is not on PATH; imageio-ffmpeg is a possible pip-provided fallback.",
                "Install OpenCV, PySceneDetect, faster-whisper and Pillow in a virtual environment before Milestone 7.",
            ],
        },
    }

    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
