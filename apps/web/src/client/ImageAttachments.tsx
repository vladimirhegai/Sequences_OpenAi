import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageInputV1 } from "../shared";
import { ApiRequestError, SequencesApi } from "./api";

const MAX_ATTACHMENTS = 4;
const MAX_BYTES = 15 * 1_024 * 1_024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

interface AttachmentItem {
  id: string;
  name: string;
  previewUrl: string | null;
  status: "uploading" | "ready" | "error";
  image: ImageInputV1 | null;
  error: string | null;
}

export interface ImageAttachmentSummary {
  paths: string[];
  busy: boolean;
  hasErrors: boolean;
}

export function ImageAttachments({
  api,
  projectId,
  disabled,
  onChange,
}: {
  api: SequencesApi;
  projectId: string;
  disabled: boolean;
  onChange: (summary: ImageAttachmentSummary) => void;
}) {
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const previews = useRef(new Set<string>());
  const removedWhileUploading = useRef(new Set<string>());

  useEffect(
    () => () => {
      for (const url of previews.current) URL.revokeObjectURL(url);
      previews.current.clear();
    },
    [],
  );

  useEffect(() => {
    onChange({
      paths: items.flatMap((item) => (item.image ? [item.image.path] : [])),
      busy: items.some((item) => item.status === "uploading"),
      hasErrors: items.some((item) => item.status === "error"),
    });
  }, [items, onChange]);

  const addFiles = useCallback(
    (files: readonly File[]) => {
      if (disabled || files.length === 0) return;
      const capacity = Math.max(0, MAX_ATTACHMENTS - items.length);
      const selected = [...files].slice(0, capacity);
      const nextItems = selected.map(toAttachmentItem);
      for (const item of nextItems) {
        if (item.previewUrl) previews.current.add(item.previewUrl);
      }
      setItems((current) => [...current, ...nextItems]);
      for (const [index, file] of selected.entries()) {
        const item = nextItems[index]!;
        if (item.status === "error") continue;
        void api
          .uploadImage(projectId, file)
          .then((image) => {
            if (removedWhileUploading.current.delete(item.id)) {
              void api.discardImage(projectId, image.path).catch(() => undefined);
              return;
            }
            setItems((current) =>
              current.map((candidate) =>
                candidate.id === item.id
                  ? { ...candidate, image, status: "ready", error: null }
                  : candidate,
              ),
            );
          })
          .catch((reason: unknown) => {
            if (removedWhileUploading.current.delete(item.id)) return;
            const message =
              reason instanceof ApiRequestError
                ? reason.message
                : "The local server could not stage this image.";
            setItems((current) =>
              current.map((candidate) =>
                candidate.id === item.id
                  ? { ...candidate, status: "error", error: message }
                  : candidate,
              ),
            );
          });
      }
    },
    [api, disabled, items.length, projectId],
  );

  const remove = useCallback(
    (item: AttachmentItem) => {
      if (item.status === "uploading") removedWhileUploading.current.add(item.id);
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      if (item.previewUrl) {
        URL.revokeObjectURL(item.previewUrl);
        previews.current.delete(item.previewUrl);
      }
      if (item.image) void api.discardImage(projectId, item.image.path).catch(() => undefined);
    },
    [api, projectId],
  );

  return (
    <section className="image-attachments" aria-label="Reference screenshots">
      <input
        ref={inputRef}
        className="image-attachments__input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        disabled={disabled || items.length >= MAX_ATTACHMENTS}
        onChange={(event) => {
          addFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      <button
        className={`image-dropzone${dragging ? " image-dropzone--active" : ""}`}
        type="button"
        disabled={disabled || items.length >= MAX_ATTACHMENTS}
        onClick={() => inputRef.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <span>Attach product screenshots</span>
        <small>PNG, JPEG, or WebP · up to {MAX_ATTACHMENTS} files · 15 MiB each</small>
      </button>

      {items.length > 0 ? (
        <ul className="image-attachments__list" aria-live="polite">
          {items.map((item) => (
            <li key={item.id} className={`image-attachment image-attachment--${item.status}`}>
              {item.previewUrl ? <img src={item.previewUrl} alt="" /> : <span aria-hidden="true" />}
              <div>
                <strong title={item.name}>{item.name}</strong>
                <small>{attachmentDetail(item)}</small>
              </div>
              <button type="button" disabled={disabled} onClick={() => remove(item)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function toAttachmentItem(file: File): AttachmentItem {
  const id = globalThis.crypto.randomUUID();
  if (!ALLOWED_TYPES.has(file.type)) {
    return {
      id,
      name: file.name,
      previewUrl: null,
      status: "error",
      image: null,
      error: "Use a PNG, JPEG, or WebP image.",
    };
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return {
      id,
      name: file.name,
      previewUrl: null,
      status: "error",
      image: null,
      error: file.size <= 0 ? "This image is empty." : "Images cannot exceed 15 MiB.",
    };
  }
  return {
    id,
    name: file.name,
    previewUrl: URL.createObjectURL(file),
    status: "uploading",
    image: null,
    error: null,
  };
}

function attachmentDetail(item: AttachmentItem): string {
  if (item.status === "uploading") return "Staging securely…";
  if (item.error) return item.error;
  if (!item.image) return "Image unavailable";
  return `${item.image.width} × ${item.image.height} · ${formatBytes(item.image.bytes)} · ${item.image.sha256.slice(0, 10)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}
