#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const standaloneCode = require("ajv/dist/standalone").default || require("ajv/dist/standalone");
const esbuild = require("esbuild");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT_DIR, "shared", "validators.standalone.js");

const bundleSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://mazebench.dev/schemas/bundle.json",
  "$defs": {
    "journal_record": {
      "type": "object",
      "discriminator": { "propertyName": "type" },
      "oneOf": [
        {
          "properties": {
            "journal_seq": { "type": "integer", "minimum": 1 },
            "timestamp": { "type": "string", "format": "date-time" },
            "run_id": { "type": "string", "pattern": "^ext-[0-9a-fA-F-]+$" },
            "type": { "const": "run_armed" },
            "manifest": { "$ref": "#/$defs/manifest_payload" },
            "manifest_digest": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
            "world_bundle_digest": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
            "base_viewer_state_digest": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
            "duration_ms": { "type": "integer", "minimum": 1000 },
            "win_threshold": { "type": "integer", "minimum": 1 },
            "model_name": { "type": ["string", "null"], "maxLength": 128 },
            "harness_name": { "type": ["string", "null"], "maxLength": 128 }
          },
          "required": ["journal_seq", "timestamp", "run_id", "type", "manifest", "manifest_digest", "world_bundle_digest", "base_viewer_state_digest", "duration_ms", "win_threshold"],
          "additionalProperties": false
        },
        {
          "properties": {
            "journal_seq": { "type": "integer", "minimum": 1 },
            "timestamp": { "type": "string", "format": "date-time" },
            "run_id": { "type": "string", "pattern": "^ext-[0-9a-fA-F-]+$" },
            "type": { "const": "run_started" },
            "operation_id": { "type": "string", "maxLength": 128 },
            "request_fingerprint": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
            "controller_id": { "type": "string", "maxLength": 128 },
            "declared_cli": { "type": ["string", "null"], "maxLength": 128 },
            "lease_id": { "type": "string", "maxLength": 128 },
            "lease_epoch": { "type": "integer", "const": 1 },
            "started_at": { "type": "string", "format": "date-time" },
            "deadline_at": { "type": "string", "format": "date-time" },
            "lease_expires_at": { "type": "string", "format": "date-time" },
            "initial_sanitized_result": { "$ref": "#/$defs/mcp_call_result" }
          },
          "required": ["journal_seq", "timestamp", "run_id", "type", "operation_id", "request_fingerprint", "controller_id", "lease_id", "lease_epoch", "started_at", "deadline_at", "lease_expires_at", "initial_sanitized_result"],
          "additionalProperties": false
        },
        {
          "properties": {
            "journal_seq": { "type": "integer", "minimum": 1 },
            "timestamp": { "type": "string", "format": "date-time" },
            "run_id": { "type": "string", "pattern": "^ext-[0-9a-fA-F-]+$" },
            "type": { "const": "lease_attached" },
            "operation_id": { "type": "string", "maxLength": 128 },
            "request_fingerprint": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
            "controller_id": { "type": "string", "maxLength": 128 },
            "declared_cli": { "type": ["string", "null"], "maxLength": 128 },
            "lease_id": { "type": "string", "maxLength": 128 },
            "lease_epoch": { "type": "integer", "minimum": 2 },
            "lease_expires_at": { "type": "string", "format": "date-time" },
            "sanitized_result": { "$ref": "#/$defs/mcp_call_result" }
          },
          "required": ["journal_seq", "timestamp", "run_id", "type", "operation_id", "request_fingerprint", "controller_id", "lease_id", "lease_epoch", "lease_expires_at", "sanitized_result"],
          "additionalProperties": false
        },
        {
          "properties": {
            "journal_seq": { "type": "integer", "minimum": 1 },
            "timestamp": { "type": "string", "format": "date-time" },
            "run_id": { "type": "string", "pattern": "^ext-[0-9a-fA-F-]+$" },
            "type": { "const": "lease_revoked" },
            "operation_id": { "type": "string", "maxLength": 128 },
            "request_fingerprint": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
            "controller_id": { "type": "string", "maxLength": 128 },
            "lease_id": { "type": "string", "maxLength": 128 },
            "lease_epoch": { "type": "integer", "minimum": 1 },
            "reason": { "type": "string", "maxLength": 256 },
            "sanitized_result": { "$ref": "#/$defs/mcp_call_result" }
          },
          "required": ["journal_seq", "timestamp", "run_id", "type", "operation_id", "request_fingerprint", "controller_id", "lease_id", "lease_epoch", "reason", "sanitized_result"],
          "additionalProperties": false
        },
        {
          "properties": {
            "journal_seq": { "type": "integer", "minimum": 1 },
            "timestamp": { "type": "string", "format": "date-time" },
            "run_id": { "type": "string", "pattern": "^ext-[0-9a-fA-F-]+$" },
            "type": { "const": "action_committed" },
            "operation_id": { "type": "string", "maxLength": 128 },
            "request_fingerprint": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
            "controller_id": { "type": "string", "maxLength": 128 },
            "lease_id": { "type": "string", "maxLength": 128 },
            "lease_epoch": { "type": "integer", "minimum": 1 },
            "action_seq": { "type": "integer", "minimum": 1 },
            "event_id": { "type": "integer", "minimum": 1 },
            "action_record": { "$ref": "#/$defs/action_record_v1" },
            "sanitized_result": { "$ref": "#/$defs/mcp_call_result" },
            "viewer_state_hash": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
          },
          "required": ["journal_seq", "timestamp", "run_id", "type", "operation_id", "request_fingerprint", "controller_id", "lease_id", "lease_epoch", "action_seq", "event_id", "action_record", "sanitized_result", "viewer_state_hash"],
          "additionalProperties": false
        },
        {
          "properties": {
            "journal_seq": { "type": "integer", "minimum": 1 },
            "timestamp": { "type": "string", "format": "date-time" },
            "run_id": { "type": "string", "pattern": "^ext-[0-9a-fA-F-]+$" },
            "type": { "const": "action_rejected" },
            "operation_id": { "type": "string", "maxLength": 128 },
            "request_fingerprint": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
            "controller_id": { "type": "string", "maxLength": 128 },
            "lease_id": { "type": "string", "maxLength": 128 },
            "lease_epoch": { "type": "integer", "minimum": 1 },
            "event_id": { "type": "integer", "minimum": 1 },
            "tool": { "type": "string", "maxLength": 64 },
            "arguments": { "$ref": "#/$defs/action_rejected_arguments" },
            "error_payload": { "$ref": "#/$defs/error_payload_safe" }
          },
          "required": ["journal_seq", "timestamp", "run_id", "type", "operation_id", "request_fingerprint", "controller_id", "lease_id", "lease_epoch", "event_id", "tool", "arguments", "error_payload"],
          "additionalProperties": false
        },
        {
          "properties": {
            "journal_seq": { "type": "integer", "minimum": 1 },
            "timestamp": { "type": "string", "format": "date-time" },
            "run_id": { "type": "string", "pattern": "^ext-[0-9a-fA-F-]+$" },
            "type": { "const": "finalize_intent" },
            "operation_id": { "type": "string", "maxLength": 128 },
            "request_fingerprint": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
            "target_outcome": { "type": "string", "enum": ["won", "timed_out", "cancelled"] },
            "finalize_seq": { "type": "integer", "minimum": 1 },
            "finalize_started_at": { "type": "string", "format": "date-time" },
            "reason": { "type": "string", "maxLength": 256 }
          },
          "required": ["journal_seq", "timestamp", "run_id", "type", "operation_id", "request_fingerprint", "target_outcome", "finalize_seq", "finalize_started_at", "reason"],
          "additionalProperties": false
        },
        {
          "properties": {
            "journal_seq": { "type": "integer", "minimum": 1 },
            "timestamp": { "type": "string", "format": "date-time" },
            "run_id": { "type": "string", "pattern": "^ext-[0-9a-fA-F-]+$" },
            "type": { "const": "run_finalized" },
            "outcome": { "type": "string", "enum": ["won", "timed_out", "cancelled"] },
            "ended_event_id": { "type": "integer", "minimum": 1 },
            "summary_digest": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
            "operation_id": { "type": "string", "maxLength": 128 },
            "request_fingerprint": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
            "final_response": { "$ref": "#/$defs/final_response_payload" }
          },
          "required": ["journal_seq", "timestamp", "run_id", "type", "outcome", "ended_event_id", "summary_digest", "operation_id", "request_fingerprint", "final_response"],
          "additionalProperties": false
        },
        {
          "properties": {
            "journal_seq": { "type": "integer", "minimum": 1 },
            "timestamp": { "type": "string", "format": "date-time" },
            "run_id": { "type": "string", "pattern": "^ext-[0-9a-fA-F-]+$" },
            "type": { "const": "run_failed" },
            "outcome": { "type": "string", "const": "failed" },
            "failed_at": { "type": "string", "format": "date-time" },
            "error": { "$ref": "#/$defs/error_payload_safe" },
            "ended_event_id": { "type": "integer", "minimum": 1 },
            "partial_summary_digest": { "type": ["string", "null"], "pattern": "^[0-9a-f]{64}$" },
            "operation_id": { "type": "string", "maxLength": 128 },
            "request_fingerprint": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
            "final_response": { "$ref": "#/$defs/final_response_payload" }
          },
          "required": ["journal_seq", "timestamp", "run_id", "type", "outcome", "failed_at", "error", "ended_event_id", "partial_summary_digest", "operation_id", "request_fingerprint", "final_response"],
          "additionalProperties": false
        }
      ]
    },
    "action_record_v1": {
      "type": "object",
      "required": [
        "schema_version", "seq", "turn", "tool", "command_text", "message",
        "valid", "accepted", "error", "sanitized_status",
        "before_state_hash", "after_state_hash"
      ],
      "properties": {
        "schema_version": { "type": "integer", "const": 1 },
        "seq": { "type": "integer", "minimum": 1 },
        "turn": { "type": "integer", "minimum": 1 },
        "tool": { "type": "string", "maxLength": 64 },
        "command_text": { "type": "string", "maxLength": 256 },
        "message": { "$ref": "#/$defs/action_message_payload" },
        "valid": { "type": "boolean", "const": true },
        "accepted": { "type": "boolean", "const": true },
        "error": { "type": "null" },
        "sanitized_status": { "$ref": "#/$defs/sanitized_status_payload" },
        "viewer_transition": {
          "type": ["object", "null"],
          "required": ["v", "type", "duration_ms", "room", "actor_deltas", "gem_deltas", "terrain_deltas", "camera_delta", "world_transition", "keyframes"],
          "properties": {
            "v": { "type": "integer", "const": 1 },
            "type": { "type": "string", "enum": ["move", "slide", "rotate", "teleport", "reset", "fall_recover", "no_op"] },
            "duration_ms": { "type": "integer", "minimum": 0 },
            "room": { "type": "string" },
            "actor_deltas": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["id", "type", "room", "before", "after", "action", "start_time_ratio", "end_time_ratio"],
                "properties": {
                  "id": { "type": "string" },
                  "type": { "type": "string" },
                  "room": { "type": "string" },
                  "before": { "type": "object", "required": ["x", "y", "elevation", "removed"], "properties": { "x": { "type": "number" }, "y": { "type": "number" }, "elevation": { "type": "number" }, "removed": { "type": "boolean" } }, "additionalProperties": false },
                  "after": { "type": "object", "required": ["x", "y", "elevation", "removed"], "properties": { "x": { "type": "number" }, "y": { "type": "number" }, "elevation": { "type": "number" }, "removed": { "type": "boolean" } }, "additionalProperties": false },
                  "action": { "type": "string", "enum": ["move", "push", "fall", "revive", "collect_gem"] },
                  "start_time_ratio": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
                  "end_time_ratio": { "type": "number", "minimum": 0.0, "maximum": 1.0 }
                },
                "additionalProperties": false
              }
            },
            "gem_deltas": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["id", "action", "from_elevation", "to_elevation", "start_time_ratio", "end_time_ratio"],
                "properties": {
                  "id": { "type": "string" },
                  "action": { "type": "string", "enum": ["collect", "remove", "fade"] },
                  "from_elevation": { "type": "number" },
                  "to_elevation": { "type": "number" },
                  "start_time_ratio": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
                  "end_time_ratio": { "type": "number", "minimum": 0.0, "maximum": 1.0 }
                },
                "additionalProperties": false
              }
            },
            "terrain_deltas": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["index", "type", "before_raised", "after_raised", "start_time_ratio", "end_time_ratio"],
                "properties": {
                  "index": { "type": "integer" },
                  "type": { "type": "string" },
                  "before_raised": { "type": "boolean" },
                  "after_raised": { "type": "boolean" },
                  "start_time_ratio": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
                  "end_time_ratio": { "type": "number", "minimum": 0.0, "maximum": 1.0 }
                },
                "additionalProperties": false
              }
            },
            "camera_delta": {
              "type": ["object", "null"],
              "properties": {
                "from_pitch": { "type": "integer", "minimum": 0, "maximum": 4 },
                "to_pitch": { "type": "integer", "minimum": 0, "maximum": 4 },
                "from_yaw": { "type": "integer", "minimum": 0, "maximum": 3 },
                "to_yaw": { "type": "integer", "minimum": 0, "maximum": 3 }
              },
              "additionalProperties": false
            },
            "world_transition": {
              "type": ["object", "null"],
              "properties": {
                "source_room": { "type": "string" },
                "target_room": { "type": "string" },
                "direction": { "type": "string" },
                "outgoing_scene_digest": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
                "incoming_scene_digest": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
              },
              "additionalProperties": false
            },
            "keyframes": {
              "type": "array",
              "minItems": 2,
              "items": {
                "type": "object",
                "required": ["time_ratio", "viewer_state", "viewer_state_hash"],
                "properties": {
                  "time_ratio": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
                  "viewer_state": { "$ref": "#/$defs/viewer_state_v1" },
                  "viewer_state_hash": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
                },
                "additionalProperties": false
              }
            }
          },
          "additionalProperties": false
        },
        "transition_digest": { "type": ["string", "null"], "pattern": "^[0-9a-f]{64}$" },
        "post_viewer_state": {
          "oneOf": [
            { "$ref": "#/$defs/viewer_state_v1" },
            { "type": "null" }
          ]
        },
        "post_viewer_state_digest": { "type": ["string", "null"], "pattern": "^[0-9a-f]{64}$" },
        "before_state_hash": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
        "after_state_hash": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
      },
      "allOf": [
        {
          "oneOf": [
            { "required": ["viewer_transition"], "properties": { "viewer_transition": { "type": "object" }, "transition_digest": { "type": "null" } } },
            { "required": ["transition_digest"], "properties": { "transition_digest": { "type": "string" }, "viewer_transition": { "type": "null" } } }
          ]
        },
        {
          "oneOf": [
            { "required": ["post_viewer_state"], "properties": { "post_viewer_state": { "type": "object" }, "post_viewer_state_digest": { "type": "null" } } },
            { "required": ["post_viewer_state_digest"], "properties": { "post_viewer_state_digest": { "type": "string" }, "post_viewer_state": { "type": "null" } } }
          ]
        }
      ],
      "additionalProperties": false
    },
    "viewer_state_v1": {
      "type": "object",
      "required": [
        "v", "action_seq", "current_room", "player", "pitch", "yaw",
        "actors", "gems", "collected_gems", "terrain_overrides", "world_bundle_digest"
      ],
      "properties": {
        "v": { "type": "integer", "const": 1 },
        "action_seq": { "type": "integer", "minimum": 0 },
        "current_room": { "type": "string" },
        "player": {
          "type": ["object", "null"],
          "required": ["x", "y", "elevation"],
          "properties": {
            "x": { "type": "number" },
            "y": { "type": "number" },
            "elevation": { "type": "number" },
            "viewer_actor_index": { "type": "integer" }
          },
          "additionalProperties": false
        },
        "pitch": { "type": "integer", "minimum": 0, "maximum": 4 },
        "yaw": { "type": "integer", "minimum": 0, "maximum": 3 },
        "actors": {
          "type": "array",
          "maxItems": 256,
          "items": {
            "type": "object",
            "required": ["id", "type", "x", "y", "elevation", "removed"],
            "properties": {
              "id": { "type": "string" },
              "type": { "type": "string" },
              "x": { "type": "number" },
              "y": { "type": "number" },
              "elevation": { "type": "number" },
              "removed": { "type": "boolean" },
              "viewer_actor_index": { "type": "integer" }
            },
            "additionalProperties": false
          }
        },
        "gems": {
          "type": "array",
          "maxItems": 256,
          "items": {
            "type": "object",
            "required": ["id", "collected", "removed"],
            "properties": {
              "id": { "type": "string" },
              "collected": { "type": "boolean" },
              "removed": { "type": "boolean" },
              "elevation": { "type": "number" },
              "viewer_actor_index": { "type": "integer" }
            },
            "additionalProperties": false
          }
        },
        "collected_gems": {
          "type": "array",
          "maxItems": 256,
          "items": { "type": "string" }
        },
        "terrain_overrides": {
          "type": "array",
          "maxItems": 256,
          "items": {
            "type": "object",
            "required": ["index", "raised"],
            "properties": {
              "index": { "type": "integer", "minimum": 0 },
              "type": { "type": "string" },
              "raised": { "type": "boolean" }
            },
            "additionalProperties": false
          }
        },
        "world_bundle_digest": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
      },
      "additionalProperties": false
    },
    "summary_v1": {
      "type": "object",
      "required": [
        "summary_schema_version", "run_id", "outcome", "is_partial",
        "started_at", "ended_at", "elapsed_seconds", "gems_collected",
        "gems_total", "rooms_visited", "rooms_total", "actions_total",
        "declared_cli", "declared_model", "route", "progress_curve"
      ],
      "properties": {
        "summary_schema_version": { "type": "integer", "const": 1 },
        "run_id": { "type": "string", "pattern": "^ext-[0-9a-fA-F-]+$" },
        "outcome": { "type": "string", "enum": ["won", "timed_out", "cancelled", "failed"] },
        "is_partial": { "type": "boolean" },
        "started_at": { "type": ["string", "null"], "format": "date-time" },
        "ended_at": { "type": "string", "format": "date-time" },
        "elapsed_seconds": { "type": ["number", "null"], "minimum": 0 },
        "gems_collected": { "type": "integer", "minimum": 0 },
        "gems_total": { "type": "integer", "minimum": 0 },
        "rooms_visited": { "type": "integer", "minimum": 0 },
        "rooms_total": { "type": "integer", "minimum": 0 },
        "actions_total": { "type": "integer", "minimum": 0 },
        "declared_cli": { "type": "string", "maxLength": 128 },
        "declared_model": { "type": ["string", "null"], "maxLength": 128 },
        "route": { "type": "array", "maxItems": 1024, "items": { "type": "string" } },
        "progress_curve": {
          "type": "array",
          "maxItems": 2048,
          "items": {
            "type": "object",
            "required": ["action_seq", "gems", "rooms"],
            "properties": {
              "action_seq": { "type": "integer", "minimum": 0 },
              "gems": { "type": "integer", "minimum": 0 },
              "rooms": { "type": "integer", "minimum": 0 }
            },
            "additionalProperties": false
          }
        }
      },
      "oneOf": [
        {
          "properties": {
            "outcome": { "enum": ["won", "timed_out"] },
            "is_partial": { "const": false },
            "started_at": { "type": "string", "format": "date-time" },
            "elapsed_seconds": { "type": "number", "minimum": 0 }
          }
        },
        {
          "properties": {
            "outcome": { "enum": ["cancelled", "failed"] },
            "is_partial": { "const": true },
            "started_at": { "type": "string", "format": "date-time" },
            "elapsed_seconds": { "type": "number", "minimum": 0 }
          }
        },
        {
          "properties": {
            "outcome": { "enum": ["cancelled", "failed"] },
            "is_partial": { "const": true },
            "started_at": { "type": "null" },
            "elapsed_seconds": { "type": "null" }
          }
        }
      ],
      "additionalProperties": false
    },
    "error_payload_safe": {
      "type": "object",
      "required": ["code", "message"],
      "properties": {
        "code": { "type": "string", "enum": ["INVALID_ARGUMENT", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "PRECONDITION_FAILED", "RESOURCE_EXHAUSTED", "INTERNAL_ERROR"] },
        "message": { "type": "string", "maxLength": 512 }
      },
      "additionalProperties": false
    },
    "manifest_payload": {
      "type": "object",
      "required": ["run_id", "run_kind", "execution_class", "benchmark_eligible", "created_at", "duration_ms", "win_threshold"],
      "properties": {
        "run_id": { "type": "string", "pattern": "^ext-[0-9a-fA-F-]+$" },
        "run_kind": { "type": "string", "const": "external_play" },
        "execution_class": { "type": "string", "const": "external-unverified" },
        "benchmark_eligible": { "type": "boolean", "const": false },
        "created_at": { "type": "string", "format": "date-time" },
        "duration_ms": { "type": "integer", "minimum": 1000 },
        "win_threshold": { "type": "integer", "minimum": 1 }
      },
      "additionalProperties": false
    },
    "mcp_call_result": {
      "type": "object",
      "required": ["resultType", "content", "isError"],
      "properties": {
        "resultType": { "type": "string", "const": "complete" },
        "content": {
          "type": "array",
          "maxItems": 8,
          "items": {
            "type": "object",
            "required": ["type", "text"],
            "properties": {
              "type": { "type": "string", "const": "text" },
              "text": { "type": "string", "maxLength": 16384 }
            },
            "additionalProperties": false
          }
        },
        "isError": { "type": "boolean" }
      },
      "additionalProperties": false
    },
    "action_message_payload": {
      "type": "object",
      "oneOf": [
        {
          "properties": {
            "command": { "const": "move" },
            "direction": { "enum": ["up", "down", "left", "right"] }
          },
          "required": ["command", "direction"],
          "additionalProperties": false
        },
        {
          "properties": {
            "command": { "const": "rotate_camera" },
            "direction": { "enum": ["up", "down", "left", "right"] }
          },
          "required": ["command", "direction"],
          "additionalProperties": false
        },
        {
          "properties": {
            "command": { "const": "undo" }
          },
          "required": ["command"],
          "additionalProperties": false
        },
        {
          "properties": {
            "command": { "const": "reset_level" }
          },
          "required": ["command"],
          "additionalProperties": false
        },
        {
          "properties": {
            "command": { "const": "goto_level" },
            "x": { "type": "string", "pattern": "^[A-Za-z]$" },
            "y": { "type": "string", "pattern": "^[A-Za-z]$" }
          },
          "required": ["command", "x", "y"],
          "additionalProperties": false
        }
      ]
    },
    "action_rejected_arguments": {
      "type": "object",
      "maxProperties": 8,
      "properties": {
        "x": { "type": "string", "maxLength": 8 },
        "y": { "type": "string", "maxLength": 8 },
        "direction": { "type": "string", "maxLength": 16 }
      },
      "additionalProperties": {
        "type": ["string", "number", "boolean", "null"],
        "maxLength": 64
      }
    },
    "sanitized_status_payload": {
      "type": "object",
      "required": ["ok", "action_count", "current_room", "collected_gems_count", "game_won", "player_dead"],
      "properties": {
        "ok": { "type": "boolean" },
        "action_count": { "type": "integer", "minimum": 0 },
        "current_room": { "type": "string", "maxLength": 64 },
        "collected_gems_count": { "type": "integer", "minimum": 0 },
        "game_won": { "type": "boolean" },
        "player_dead": { "type": "boolean" }
      },
      "additionalProperties": false
    },
    "final_response_payload": {
      "type": "object",
      "required": ["run_id", "outcome", "summary_digest", "summary_url"],
      "properties": {
        "run_id": { "type": "string", "pattern": "^ext-[0-9a-fA-F-]+$" },
        "outcome": { "type": "string", "enum": ["won", "timed_out", "cancelled", "failed"] },
        "summary_digest": { "type": ["string", "null"], "pattern": "^[0-9a-f]{64}$" },
        "summary_url": { "type": ["string", "null"], "maxLength": 256 }
      },
      "additionalProperties": false
    },
    "sse_event": {
      "type": "object",
      "discriminator": { "propertyName": "type" },
      "oneOf": [
        {
          "properties": {
            "event_id": { "type": "integer", "minimum": 1 },
            "type": { "const": "started" },
            "started_at": { "type": "string", "format": "date-time" },
            "deadline_at": { "type": "string", "format": "date-time" },
            "duration_ms": { "type": "integer", "minimum": 1000 },
            "controller_id": { "type": ["string", "null"], "maxLength": 128 },
            "declared_cli": { "type": ["string", "null"], "maxLength": 128 }
          },
          "required": ["event_id", "type", "started_at", "deadline_at", "duration_ms"],
          "additionalProperties": false
        },
        {
          "properties": {
            "event_id": { "type": "integer", "minimum": 1 },
            "type": { "const": "action" },
            "action_seq": { "type": "integer", "minimum": 1 },
            "tool": { "type": "string", "maxLength": 64 },
            "action_record": { "$ref": "#/$defs/action_record_v1" }
          },
          "required": ["event_id", "type", "action_seq", "tool", "action_record"],
          "additionalProperties": false
        },
        {
          "properties": {
            "event_id": { "type": "integer", "minimum": 1 },
            "type": { "const": "action_rejected" },
            "action_seq": { "type": "integer", "minimum": 0 },
            "tool": { "type": "string", "maxLength": 64 },
            "error": { "type": "string", "maxLength": 256 }
          },
          "required": ["event_id", "type", "action_seq", "tool", "error"],
          "additionalProperties": false
        },
        {
          "properties": {
            "event_id": { "type": "integer", "minimum": 1 },
            "type": { "const": "ended" },
            "action_seq": { "type": "integer", "minimum": 0 },
            "outcome": { "type": "string", "enum": ["won", "timed_out", "cancelled", "failed"] },
            "summary_digest": { "type": ["string", "null"], "pattern": "^[0-9a-f]{64}$" },
            "summary_url": { "type": ["string", "null"], "maxLength": 256 }
          },
          "required": ["event_id", "type", "action_seq", "outcome", "summary_digest", "summary_url"],
          "additionalProperties": false
        }
      ]
    }
  }
};

function buildValidators() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    discriminator: true,
    code: { source: true, esm: false }
  });
  addFormats(ajv);

  ajv.addSchema(bundleSchema, "https://mazebench.dev/schemas/bundle.json");

  const mapping = {
    validateJournalRecord: "https://mazebench.dev/schemas/bundle.json#/$defs/journal_record",
    validateActionRecord: "https://mazebench.dev/schemas/bundle.json#/$defs/action_record_v1",
    validateViewerState: "https://mazebench.dev/schemas/bundle.json#/$defs/viewer_state_v1",
    validateViewerTransition: "https://mazebench.dev/schemas/bundle.json#/$defs/action_record_v1/properties/viewer_transition",
    validateSummary: "https://mazebench.dev/schemas/bundle.json#/$defs/summary_v1",
    validateSSEEvent: "https://mazebench.dev/schemas/bundle.json#/$defs/sse_event",
    validateManifest: "https://mazebench.dev/schemas/bundle.json#/$defs/manifest_payload",
    validateMcpCallResult: "https://mazebench.dev/schemas/bundle.json#/$defs/mcp_call_result",
    validateActionMessage: "https://mazebench.dev/schemas/bundle.json#/$defs/action_message_payload",
    validateSanitizedStatus: "https://mazebench.dev/schemas/bundle.json#/$defs/sanitized_status_payload",
    validateFinalResponse: "https://mazebench.dev/schemas/bundle.json#/$defs/final_response_payload",
    validateErrorPayload: "https://mazebench.dev/schemas/bundle.json#/$defs/error_payload_safe"
  };

  const rawCode = standaloneCode(ajv, mapping);

  // Package helpers and canonical JCS hashing with the standalone validators
  const helperCode = `
// RFC 8785 JSON Canonicalization Scheme (JCS)
function canonicalizeJson(obj) {
  if (obj === null || typeof obj !== "object") {
    if (typeof obj === "number") {
      if (!Number.isFinite(obj)) throw new TypeError("Non-finite number in canonicalizeJson");
      if (Object.is(obj, -0)) return "0";
      return String(obj);
    }
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalizeJson).join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ":" + canonicalizeJson(obj[k]));
  return "{" + pairs.join(",") + "}";
}

// Compute deterministic SHA-256 hash of canonical JCS viewer state v1
function computeViewerStateHash(viewerState) {
  const _nodeCrypto = typeof require === "function" ? (function() { try { return require("crypto"); } catch (_e) { return null; } })() : null;
  function quantize(val) {
    if (typeof val === "number") {
      if (!Number.isFinite(val)) throw new TypeError("Non-finite float in viewer_state");
      if (Object.is(val, -0)) return 0;
      return Math.round(val * 10000) / 10000;
    }
    return val;
  }
  function quantizePos(p) {
    if (!p) return null;
    return {
      x: quantize(p.x),
      y: quantize(p.y),
      elevation: quantize(p.elevation)
    };
  }
  const cleanState = {
    v: 1,
    action_seq: viewerState.action_seq,
    current_room: viewerState.current_room,
    player: quantizePos(viewerState.player),
    pitch: viewerState.pitch,
    yaw: viewerState.yaw,
    actors: [...(viewerState.actors || [])]
      .map(a => ({
        id: a.id,
        type: a.type,
        x: quantize(a.x),
        y: quantize(a.y),
        elevation: quantize(a.elevation),
        removed: Boolean(a.removed)
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    gems: [...(viewerState.gems || [])]
      .map(g => ({
        id: g.id,
        collected: Boolean(g.collected),
        removed: Boolean(g.removed)
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    collected_gems: [...(viewerState.collected_gems || [])].sort(),
    terrain_overrides: [...(viewerState.terrain_overrides || [])]
      .map(t => ({
        index: t.index,
        type: t.type,
        raised: Boolean(t.raised)
      }))
      .sort((a, b) => a.index - b.index),
    world_bundle_digest: viewerState.world_bundle_digest
  };
  const canonicalJson = canonicalizeJson(cleanState);
  if (_nodeCrypto) {
    return _nodeCrypto.createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  }
  return "";
}
`;

  const combinedSource = "var module = typeof module !== 'undefined' ? module : { exports: {} };\n" +
    "var exports = module.exports;\n" +
    rawCode + "\n" + helperCode + "\n" +
    "module.exports.canonicalizeJson = canonicalizeJson;\n" +
    "module.exports.computeViewerStateHash = computeViewerStateHash;\n" +
    "module.exports.BUNDLE_SCHEMA = " + JSON.stringify(bundleSchema) + ";\n" +
    "if (typeof window !== 'undefined') { window.Validators = module.exports; }\n" +
    "if (typeof globalThis !== 'undefined') { globalThis.Validators = module.exports; }\n";

  const tempEntry = path.join(ROOT_DIR, "scripts", ".temp-validator-entry.js");
  try {
    fs.writeFileSync(tempEntry, combinedSource, "utf8");
    // 1. Build Node CJS bundle
    const buildResult = esbuild.buildSync({
      entryPoints: [tempEntry],
      outfile: OUTPUT_PATH,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node18",
      minify: false
    });

    if (buildResult.errors && buildResult.errors.length > 0) {
      throw new Error("esbuild bundling failed: " + JSON.stringify(buildResult.errors));
    }

    // 2. Build Browser IIFE bundle for public/validators.standalone.js
    const publicOut = path.join(ROOT_DIR, "public", "validators.standalone.js");
    esbuild.buildSync({
      entryPoints: [tempEntry],
      outfile: publicOut,
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "Validators",
      external: ["crypto"],
      target: "es2020",
      minify: false
    });
  } finally {
    if (fs.existsSync(tempEntry)) {
      fs.unlinkSync(tempEntry);
    }
  }

  // Scan output for any bare require() to external npm packages (ignoring string literals)
  const outputCode = fs.readFileSync(OUTPUT_PATH, "utf8");
  // Strip comments and double/single quoted strings, template literals
  const strippedCode = outputCode
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*/g, "")
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, "``");

  const bareRequireMatches = strippedCode.match(/(?:^|[^\w$.])require\s*\(\s*["']([^"']+)["']\s*\)/g) || [];
  const allowedBuiltins = new Set(["crypto", "path", "fs", "os", "util", "stream", "buffer", "events"]);

  for (const reqMatch of bareRequireMatches) {
    const match = reqMatch.match(/require\s*\(\s*["']([^"']+)["']\s*\)/);
    if (!match) continue;
    const pkg = match[1];
    if (!pkg.startsWith(".") && !pkg.startsWith("/") && !allowedBuiltins.has(pkg)) {
      throw new Error(`Forbidden external require found in standalone bundle: ${pkg}`);
    }
  }

  smokeTestBundle();
  console.log(`build:validators successfully generated and verified ${OUTPUT_PATH}`);
}

function smokeTestBundle() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-val-test-"));
  const tempBundlePath = path.join(tempDir, "validators.standalone.js");
  fs.copyFileSync(OUTPUT_PATH, tempBundlePath);

  try {
    const v = require(tempBundlePath);

    // 1. Validate Journal Record (run_armed valid case)
    const validArmed = {
      journal_seq: 1,
      timestamp: "2026-08-25T12:00:00.000Z",
      run_id: "ext-12345678-abcd-ef01-2345-6789abcdef01",
      type: "run_armed",
      manifest: {
        run_id: "ext-12345678-abcd-ef01-2345-6789abcdef01",
        run_kind: "external_play",
        execution_class: "external-unverified",
        benchmark_eligible: false,
        created_at: "2026-08-25T12:00:00.000Z",
        duration_ms: 1800000,
        win_threshold: 100
      },
      manifest_digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      world_bundle_digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      base_viewer_state_digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      duration_ms: 1800000,
      win_threshold: 100
    };
    if (!v.validateJournalRecord(validArmed)) {
      throw new Error("Smoke test failed: validArmed rejected: " + JSON.stringify(v.validateJournalRecord.errors));
    }

    // 2. Negative test: invalid date-time format
    const invalidDateArmed = { ...validArmed, timestamp: "not-a-valid-date" };
    if (v.validateJournalRecord(invalidDateArmed)) {
      throw new Error("Smoke test failed: invalid date-time was accepted!");
    }

    // 3. Negative test: pattern / maxLength
    const invalidRunId = { ...validArmed, run_id: "invalid-prefix-123" };
    if (v.validateJournalRecord(invalidRunId)) {
      throw new Error("Smoke test failed: invalid run_id pattern was accepted!");
    }

    // 4. Test computeViewerStateHash
    const viewerState = {
      v: 1,
      action_seq: 0,
      current_room: "level_HxI",
      player: { x: 4.123456, y: -0, elevation: 1 },
      pitch: 1,
      yaw: 0,
      actors: [
        { id: "level_HxI:actor:1", type: "boulder", x: 2, y: 3, elevation: 0, removed: false },
        { id: "level_HxI:actor:0", type: "boulder", x: 1, y: 1, elevation: 0, removed: false }
      ],
      gems: [
        { id: "level_HxI:gem:4,5,0", collected: false, removed: false }
      ],
      collected_gems: [],
      terrain_overrides: [],
      world_bundle_digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    };
    const hash = v.computeViewerStateHash(viewerState);
    if (!hash || hash.length !== 64) {
      throw new Error("Smoke test failed: computeViewerStateHash output invalid: " + hash);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  buildValidators();
}

module.exports = { buildValidators, bundleSchema };
