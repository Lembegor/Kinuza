import { Star } from "lucide-react";
import { useImdbRating } from "../lib/imdbRatings";
import type { MediaType } from "../lib/tmdb";

export function CatalogRating({ type, id, rating, className, size }: { type: MediaType; id: number; rating: number; className: string; size: number }) {
  const shown = useImdbRating(type, id, rating);
  if (shown.rating === null) return null;
  return (
    <span ref={shown.ref} className={`${className} ${shown.rating === undefined ? "rating-pending" : ""}`}>
      <Star size={size} fill="currentColor" />
      {shown.rating?.toFixed(1)}
    </span>
  );
}
