/**
 * Shared "Upload Images" field for the mandatory 1–5 record images.
 *
 * Used by BOTH creation forms (biomass inventory lot, marketplace listing).
 * Owns file picking, drag-and-drop, previews, per-file validation feedback,
 * removal, and the live "N/5 images uploaded" count. The parent holds the
 * selected File[]; this component never submits — it validates additions
 * and reports the selection upward. The server re-validates everything.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  IMAGE_RULES,
  IMAGE_UPLOAD_HINT,
} from "../lib/api";
import {
  imageCountError,
  validateImageFiles,
  type ImageRuleError,
} from "../domain/imageValidation";

export interface ImageUploadFieldProps {
  /** The currently selected files (owned by the parent form). */
  files: readonly File[];
  /** Replaces the whole selection (called after every validated add/remove). */
  onChange: (files: File[]) => void;
  /** Unique base for element ids when more than one form is mounted. */
  idPrefix?: string;
  /** Disables adding/removing (e.g. while the record is being created). */
  disabled?: boolean;
  /** Accessible label — defaults to "Upload Images". */
  label?: string;
}

function previewUrl(file: File): string {
  return URL.createObjectURL(file);
}

export function ImageUploadField({
  files,
  onChange,
  idPrefix = "record-images",
  disabled = false,
  label = "Upload Images",
}: ImageUploadFieldProps) {
  const reactId = useId();
  const labelId = `${idPrefix}-label-${reactId}`;
  const hintId = `${idPrefix}-hint-${reactId}`;
  const errorId = `${idPrefix}-error-${reactId}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [addErrors, setAddErrors] = useState<readonly ImageRuleError[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);

  // Previews live only as long as the selection does — object URLs are
  // revoked eagerly so large previews never pile up.
  const previews = useMemo(
    () => files.map((file) => ({ file, url: previewUrl(file) })),
    [files],
  );
  useEffect(() => {
    return () => {
      for (const preview of previews) URL.revokeObjectURL(preview.url);
    };
  }, [previews]);

  const countError = useMemo(() => imageCountError(files.length), [files.length]);
  const full = files.length >= IMAGE_RULES.max;

  const addFiles = useCallback(
    async (incoming: FileList | File[] | null) => {
      if (incoming === null || disabled) return;
      const candidates = Array.from(incoming);
      if (candidates.length === 0) return;
      setBusy(true);
      try {
        const result = await validateImageFiles(candidates, files.length);
        if (result.ok) {
          if (result.accepted.length > 0) {
            setAddErrors([]);
            onChange([...files, ...result.accepted]);
          }
        } else {
          // Nothing is added silently on a rejected batch: the whole
          // selection stays as it was and every problem is reported.
          setAddErrors(result.errors);
        }
      } finally {
        setBusy(false);
        if (inputRef.current !== null) inputRef.current.value = "";
      }
    },
    [disabled, files, onChange],
  );

  const removeAt = (index: number) => {
    if (disabled) return;
    setAddErrors([]);
    onChange(files.filter((_, i) => i !== index));
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    void addFiles(event.dataTransfer?.files ?? null);
  };

  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!disabled) setDragOver(true);
  };

  const onDragLeave = () => setDragOver(false);

  // The count sentence: honest even at the bounds.
  const countLabel = `${files.length}/${IMAGE_RULES.max} images uploaded`;

  return (
    <div className="field image-upload-field">
      <span className="field-label" id={labelId}>{label} *</span>
      <p className="field-note" id={hintId}>
        {IMAGE_UPLOAD_HINT} Accepted formats: JPEG, PNG, WebP · up to{" "}
        {IMAGE_RULES.maxMb} MB each.
      </p>

      <div
        className={
          "image-upload-dropzone" +
          (dragOver ? " image-upload-dropzone--over" : "") +
          (full ? " image-upload-dropzone--full" : "")
        }
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        aria-describedby={`${hintId}${addErrors.length > 0 ? ` ${errorId}` : ""}`}
      >
        <input
          ref={inputRef}
          id={`${idPrefix}-input-${reactId}`}
          type="file"
          accept={IMAGE_RULES.acceptedMimeTypes.join(",")}
          multiple={files.length < IMAGE_RULES.max}
          disabled={disabled || full || busy}
          onChange={(event) => void addFiles(event.target.files)}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          className="visually-hidden"
        />
        <button
          type="button"
          className="btn"
          disabled={disabled || full || busy}
          onClick={() => inputRef.current?.click()}
        >
          {full ? `Maximum of ${IMAGE_RULES.max} images reached` : "Choose images"}
        </button>
        <span className="image-upload-count" aria-live="polite">{countLabel}</span>
      </div>

      {addErrors.length > 0 ? (
        <ul className="field-error" id={errorId} role="alert">
          {addErrors.map((error, index) => (
            <li key={`${error.name}-${index}`}>{error.message}</li>
          ))}
        </ul>
      ) : null}

      {countError !== null ? (
        <p className="field-error" role="alert">{countError}</p>
      ) : null}

      {previews.length > 0 ? (
        <ul className="image-upload-previews">
          {previews.map((preview, index) => (
            <li key={`${preview.file.name}-${index}`} className="image-upload-preview">
              <img
                src={preview.url}
                alt={`Selected image ${index + 1}: ${preview.file.name}`}
              />
              <button
                type="button"
                className="btn btn--small"
                disabled={disabled}
                onClick={() => removeAt(index)}
                aria-label={`Remove image ${index + 1}: ${preview.file.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
