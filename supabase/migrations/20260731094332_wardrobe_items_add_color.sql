-- Adds a color tag to wardrobe items, used by the sidebar's color filter.
-- Nullable: existing items uploaded before this feature has no known color
-- and simply won't match any color filter until re-tagged.

alter table public.wardrobe_items add column if not exists color text;

alter table public.wardrobe_items drop constraint if exists wardrobe_items_color_check;

alter table public.wardrobe_items
  add constraint wardrobe_items_color_check
  check (
    color is null or color in (
      'White', 'Black', 'Ivory', 'Beige', 'Brown', 'Grey', 'Yellow', 'Orange', 'Red', 'Green',
      'Navy', 'Blue', 'Pink', 'Purple', 'Lilac', 'Mint', 'Turquoise', 'Lemon', 'Gold', 'Silver',
      'Glitter', 'Multi-color'
    )
  );
