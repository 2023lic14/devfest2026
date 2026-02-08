from __future__ import annotations

"""MCP client wrapper for the music-tools server (Person D)."""

import json
import uuid
from typing import Any, Dict, Optional

import httpx

from src.config import settings


class MCPDirector:
	"""High-level client for MCP Streamable HTTP calls."""
	def __init__(self, server_url: str | None = None, timeout_seconds: float | None = None) -> None:
		raw_url = server_url if server_url is not None else settings.mcp_server_url
		raw_url = (raw_url or "").strip()
		if not raw_url:
			raw_url = "http://localhost:8080/mcp"
		if not raw_url.startswith(("http://", "https://")):
			raw_url = f"http://{raw_url}"
		self.server_url = raw_url
		self.timeout_seconds = timeout_seconds or settings.mcp_timeout_seconds
		self.auth_token = settings.mcp_auth_token
		self.stateless_http = settings.mcp_http_stateless
		self._session_id: Optional[str] = None
		self._client_info = {"name": "devfest-api", "version": "0.1.0"}
		self._protocol_version = "2024-11-05"

	def _headers(self, include_session: bool = True) -> Dict[str, str]:
		headers = {
			"content-type": "application/json",
			"accept": "application/json, text/event-stream",
		}
		if self.auth_token:
			headers["Authorization"] = f"Bearer {self.auth_token}"
		if include_session and self._session_id:
			headers["mcp-session-id"] = self._session_id
		return headers

	def _update_session_id(self, response: httpx.Response) -> None:
		session_id = response.headers.get("mcp-session-id") or response.headers.get("Mcp-Session-Id")
		if session_id:
			self._session_id = session_id

	def _post(self, payload: Dict[str, Any], include_session: bool = True) -> Dict[str, Any]:
		with httpx.Client(timeout=self.timeout_seconds) as client:
			response = client.post(
				self.server_url,
				json=payload,
				headers=self._headers(include_session=include_session),
			)
			self._update_session_id(response)
			content_type = response.headers.get("content-type", "")
			if "text/event-stream" in content_type:
				data = self._parse_event_stream(response.text)
			else:
				try:
					data = response.json()
				except ValueError:
					response.raise_for_status()
					raise

		if response.status_code >= 400:
			if isinstance(data, dict) and "error" in data:
				raise RuntimeError(data["error"])
			response.raise_for_status()

		if "error" in data:
			raise RuntimeError(data["error"])

		return data

	def _parse_event_stream(self, body: str) -> Dict[str, Any]:
		data_lines = []
		for line in body.splitlines():
			line = line.strip()
			if line.startswith("data:"):
				value = line[5:].strip()
				if value:
					data_lines.append(value)
		for raw in reversed(data_lines):
			if raw == "[DONE]":
				continue
			try:
				return json.loads(raw)
			except json.JSONDecodeError:
				continue
		raise ValueError("No JSON payload found in MCP event stream response.")

	def _initialize(self) -> None:
		if self.stateless_http:
			return
		payload = {
			"jsonrpc": "2.0",
			"id": str(uuid.uuid4()),
			"method": "initialize",
			"params": {
				"protocolVersion": self._protocol_version,
				"capabilities": {},
				"clientInfo": self._client_info,
			},
		}
		self._post(payload, include_session=False)

	def _call(self, payload: Dict[str, Any]) -> Dict[str, Any]:
		if not self.stateless_http and not self._session_id and payload.get("method") != "initialize":
			self._initialize()
		try:
			return self._post(payload, include_session=True)
		except RuntimeError as exc:
			message = str(exc)
			if "No valid MCP session" in message and not self.stateless_http:
				self._initialize()
				return self._post(payload, include_session=True)
			raise

	def call_tool(self, name: str, arguments: Dict[str, Any] | None = None) -> Dict[str, Any]:
		"""Invoke a MCP tool and return the result payload."""
		payload = {
			"jsonrpc": "2.0",
			"id": str(uuid.uuid4()),
			"method": "tools/call",
			"params": {
				"name": name,
				"arguments": arguments or {},
			},
		}
		data = self._call(payload)
		return data.get("result", {})

	def validate_blueprint(self, blueprint: Dict[str, Any]) -> Dict[str, Any]:
		"""Validate a blueprint payload using MCP."""
		return self.call_tool("validate_blueprint", {"blueprint": blueprint})

	def create_song(
		self,
		blueprint: Dict[str, Any],
		prompt: str | None = None,
		model_id: str | None = None,
		music_length_ms: int | None = None,
		force_instrumental: bool | None = None,
		output_format: str | None = None,
	) -> Dict[str, Any]:
		"""Generate a full song via the MCP create_song tool (ElevenLabs Music)."""
		arguments: Dict[str, Any] = {"blueprint": blueprint}
		if prompt is not None:
			arguments["prompt"] = prompt
		if model_id is not None:
			arguments["model_id"] = model_id
		if music_length_ms is not None:
			arguments["music_length_ms"] = music_length_ms
		if force_instrumental is not None:
			arguments["force_instrumental"] = force_instrumental
		if output_format is not None:
			arguments["output_format"] = output_format
		return self.call_tool("create_song", arguments)

	def synthesize_preview(
		self,
		text: str | None = None,
		blueprint: Dict[str, Any] | None = None,
		voice_id: str | None = None,
		model_id: str | None = None,
		stability: float | None = None,
		similarity_boost: float | None = None,
		style_exaggeration: float | None = None,
		speaker_boost: bool | None = None,
	) -> Dict[str, Any]:
		"""Generate a preview via the MCP synthesize_preview tool."""
		arguments: Dict[str, Any] = {}
		if text is not None:
			arguments["text"] = text
		if blueprint is not None:
			arguments["blueprint"] = blueprint
		if voice_id is not None:
			arguments["voice_id"] = voice_id
		if model_id is not None:
			arguments["model_id"] = model_id
		if stability is not None:
			arguments["stability"] = stability
		if similarity_boost is not None:
			arguments["similarity_boost"] = similarity_boost
		if style_exaggeration is not None:
			arguments["style_exaggeration"] = style_exaggeration
		if speaker_boost is not None:
			arguments["speaker_boost"] = speaker_boost
		return self.call_tool("synthesize_preview", arguments)
