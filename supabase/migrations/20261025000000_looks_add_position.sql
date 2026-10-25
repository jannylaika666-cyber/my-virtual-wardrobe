-- Manual display order of looks within a trip, set by drag-to-reorder on the
-- trip page. Null means "never reordered" — those looks sort first, newest
-- first, the same as before this column existed.

alter table public.looks add column if not exists position double precision;
