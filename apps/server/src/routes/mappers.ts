import type { Row } from './helpers.js';
import { parseJson } from './helpers.js';

export function mapSession(row: Row) {
  return {
    id: String(row.id),
    sourceUrl: String(row.source_url),
    currentUrl: String(row.current_url),
    title: String(row.title),
    viewport: parseJson(row.viewport_json, {}),
    projectSnapshot: parseJson(row.project_snapshot_json, undefined),
    sessionVersion: Number(row.session_version),
    runtimeStatus: String(row.runtime_status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function mapCapture(row: Row) {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    sessionVersion: Number(row.session_version),
    url: String(row.url),
    finalUrl: String(row.final_url),
    title: String(row.title),
    viewport: parseJson(row.viewport_json, {}),
    scroll: { x: Number(row.scroll_x), y: Number(row.scroll_y) },
    mode: String(row.mode),
    screenshotPath: String(row.screenshot_path),
    domTargetsPath: String(row.dom_targets_path),
    imageSize: { width: Number(row.image_width), height: Number(row.image_height) },
    createdAt: String(row.created_at)
  };
}

export function mapAnnotation(row: Row) {
  return {
    id: String(row.id),
    captureId: String(row.capture_id),
    kind: String(row.kind),
    geometry: parseJson(row.geometry_json, {}),
    target: parseJson(row.target_json, undefined),
    note: String(row.note),
    colorRole: String(row.color_role),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function mapBug(row: Row) {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    title: String(row.title),
    actual: String(row.actual),
    expected: String(row.expected),
    severity: String(row.severity),
    status: String(row.status),
    sourceUrl: String(row.source_url),
    finalUrl: String(row.final_url),
    primaryCaptureId: row.primary_capture_id ? String(row.primary_capture_id) : undefined,
    tags: parseJson(row.tags_json, []),
    references: parseJson<Array<{ kind: string; url: string; label?: string }>>(row.references_json, []),
    exportPath: row.export_path ? String(row.export_path) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function mapBugAsset(row: Row) {
  return {
    id: String(row.id),
    bugId: String(row.bug_id),
    kind: String(row.kind),
    fileName: String(row.file_name),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    label: row.label ? String(row.label) : undefined,
    createdAt: String(row.created_at)
  };
}
