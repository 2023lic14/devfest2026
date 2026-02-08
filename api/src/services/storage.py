from __future__ import annotations

"""DigitalOcean Spaces upload helper.

Uses the S3-compatible boto3 client to upload and return a signed public URL.
"""

import mimetypes

import boto3

from src.config import settings


def _spaces_client():
	"""Create a boto3 client configured for DigitalOcean Spaces."""
	return boto3.client(
		"s3",
		region_name=settings.do_spaces_region,
		endpoint_url=settings.do_spaces_endpoint,
		aws_access_key_id=settings.do_spaces_key,
		aws_secret_access_key=settings.do_spaces_secret,
	)


def upload_to_spaces(file_path: str, object_name: str) -> str:
	"""Upload a file to Spaces and return a time-limited public URL."""
	content_type, _ = mimetypes.guess_type(file_path)
	extra_args = {"ACL": "public-read"}
	if content_type:
		extra_args["ContentType"] = content_type

	client = _spaces_client()
	client.upload_file(
		Filename=file_path,
		Bucket=settings.do_spaces_bucket,
		Key=object_name,
		ExtraArgs=extra_args,
	)

	return client.generate_presigned_url(
		"get_object",
		Params={"Bucket": settings.do_spaces_bucket, "Key": object_name},
		ExpiresIn=settings.do_spaces_url_expiry_seconds,
	)


def presign_spaces_url(object_name: str) -> str:
	"""Generate a presigned GET URL for an existing Spaces object."""
	client = _spaces_client()
	return client.generate_presigned_url(
		"get_object",
		Params={"Bucket": settings.do_spaces_bucket, "Key": object_name},
		ExpiresIn=settings.do_spaces_url_expiry_seconds,
	)
