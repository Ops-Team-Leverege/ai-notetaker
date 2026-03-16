"""Compute Engine GPU instance creation and lifecycle management."""

import json
import os
import time
import logging
from google.cloud import compute_v1

logger = logging.getLogger(__name__)

PROJECT_ID = os.environ.get("GCP_PROJECT_ID", "ai-meeting-notetaker-490206")
ZONE = os.environ.get("GCP_ZONE", "us-central1-a")
MACHINE_TYPE = f"zones/{ZONE}/machineTypes/n1-standard-4"
GPU_TYPE = f"zones/{ZONE}/acceleratorTypes/nvidia-tesla-t4"
PIPELINE_IMAGE = os.environ.get("PIPELINE_IMAGE", "")
POLL_INTERVAL = int(os.environ.get("GPU_POLL_INTERVAL", "30"))
MAX_POLL_TIME = int(os.environ.get("GPU_MAX_POLL_TIME", "1800"))  # 30 min

STARTUP_SCRIPT = """#!/bin/bash
set -e

# Read task params from instance metadata
AUDIO_GCS_PATH=$(curl -s -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/audio_gcs_path)
MEETING_ID=$(curl -s -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/meeting_id)
OWNING_USER=$(curl -s -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/owning_user)
RETRY_COUNT=$(curl -s -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/retry_count)

# Run the transcription pipeline
cd /opt/pipeline
python -m src.main \
  --audio-gcs-path "$AUDIO_GCS_PATH" \
  --meeting-id "$MEETING_ID" \
  --owning-user "$OWNING_USER" \
  --retry-count "$RETRY_COUNT"

# Self-shutdown on completion
INSTANCE_NAME=$(curl -s -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/name)
ZONE=$(curl -s -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/zone | awk -F/ '{print $NF}')
gcloud compute instances delete "$INSTANCE_NAME" --zone="$ZONE" --quiet
"""


def create_gpu_instance(
    meeting_id: str,
    audio_gcs_path: str,
    owning_user: str,
    retry_count: int,
) -> str:
    """
    Create a preemptible n1-standard-4 + T4 GPU Compute Engine instance.
    Injects task parameters as instance metadata.
    Returns instance name.
    """
    instance_name = f"transcription-{meeting_id[:50]}"
    client = compute_v1.InstancesClient()

    instance = compute_v1.Instance(
        name=instance_name,
        machine_type=MACHINE_TYPE,
        scheduling=compute_v1.Scheduling(preemptible=True),
        guest_accelerators=[
            compute_v1.AcceleratorConfig(
                accelerator_type=GPU_TYPE,
                accelerator_count=1,
            )
        ],
        disks=[
            compute_v1.AttachedDisk(
                boot=True,
                auto_delete=True,
                initialize_params=compute_v1.AttachedDiskInitializeParams(
                    source_image="projects/ml-images/global/images/family/common-gpu",
                    disk_size_gb=50,
                ),
            )
        ],
        network_interfaces=[
            compute_v1.NetworkInterface(
                access_configs=[
                    compute_v1.AccessConfig(name="External NAT")
                ]
            )
        ],
        metadata=compute_v1.Metadata(
            items=[
                compute_v1.Items(key="startup-script", value=STARTUP_SCRIPT),
                compute_v1.Items(key="audio_gcs_path", value=audio_gcs_path),
                compute_v1.Items(key="meeting_id", value=meeting_id),
                compute_v1.Items(key="owning_user", value=owning_user),
                compute_v1.Items(key="retry_count", value=str(retry_count)),
            ]
        ),
    )

    operation = client.insert(project=PROJECT_ID, zone=ZONE, instance_resource=instance)
    logger.info("Creating GPU instance %s for meeting %s", instance_name, meeting_id)

    return instance_name
