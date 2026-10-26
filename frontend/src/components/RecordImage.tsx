/**
 * Image display for record views: a primary-image thumbnail for listings/
 * table rows and a small gallery for detail views.
 *
 * Legacy records may have no images (the mandatory rule applies to NEW
 * records only) — these render an honest neutral placeholder, never a
 * broken <img>. Sources point at the authorized image endpoint, so the
 * session decides what a viewer may see.
 */

import { useState } from "react";
import { recordImages, type BiomassImage } from "../lib/api";

function PrimaryThumb(props: { images: BiomassImage[]; title: string }) {
  const [broken, setBroken] = useState(false);
  const primary = props.images[0];
  if (primary === undefined || broken) {
    return (
      <span className="record-thumb record-thumb--empty" aria-hidden="true">
        —
      </span>
    );
  }
  return (
    <img
      className="record-thumb"
      src={primary.url}
      alt={`Primary image of ${props.title}`}
      onError={() => setBroken(true)}
    />
  );
}

/** Small square primary-image thumbnail for table rows and listing cards. */
export function RecordThumb(props: { images?: BiomassImage[]; title: string }) {
  return <PrimaryThumb images={recordImages(props.images)} title={props.title} />;
}

/** Full gallery for a record detail view, with simple image navigation. */
export function RecordGallery(props: { images?: BiomassImage[]; title: string }) {
  const images = recordImages(props.images);
  const [index, setIndex] = useState(0);
  const [broken, setBroken] = useState<Record<string, boolean>>({});

  if (images.length === 0) {
    return (
      <div className="record-gallery" role="group" aria-label={`${props.title} images`}>
        <p className="page-placeholder-note">No images are attached to this record.</p>
      </div>
    );
  }

  const safeIndex = Math.min(index, images.length - 1);
  const current = images[safeIndex];

  return (
    <div className="record-gallery" role="group" aria-label={`${props.title} images`}>
      <img
        className="record-gallery__main"
        src={current.url}
        alt={`Image ${safeIndex + 1} of ${images.length} for ${props.title}`}
        onError={() => setBroken((state) => ({ ...state, [current.id]: true }))}
        hidden={broken[current.id] === true}
      />
      {broken[current.id] === true ? (
        <p className="page-placeholder-note">
          Image file is unavailable right now.
        </p>
      ) : null}
      {images.length > 1 ? (
        <div className="record-gallery__thumbs">
          {images.map((image, i) => (
            <button
              key={image.id}
              type="button"
              className={
                "record-gallery__thumb" + (i === safeIndex ? " record-gallery__thumb--active" : "")
              }
              onClick={() => setIndex(i)}
              aria-current={i === safeIndex ? "true" : undefined}
              aria-label={`Show image ${i + 1} of ${images.length}`}
            >
              <img src={image.url} alt="" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
