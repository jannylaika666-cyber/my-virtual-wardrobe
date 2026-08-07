-- Adds "Denim" to the set of allowed wardrobe_items colors.

alter table public.wardrobe_items drop constraint if exists wardrobe_items_color_check;

alter table public.wardrobe_items
  add constraint wardrobe_items_color_check
  check (
    color is null or color in (
      'White', 'Black', 'Ivory', 'Beige', 'Brown', 'Grey', 'Yellow', 'Orange', 'Red', 'Green',
      'Navy', 'Blue', 'Denim', 'Pink', 'Purple', 'Lilac', 'Mint', 'Turquoise', 'Lemon', 'Gold',
      'Silver', 'Glitter', 'Multi-color'
    )
  );
