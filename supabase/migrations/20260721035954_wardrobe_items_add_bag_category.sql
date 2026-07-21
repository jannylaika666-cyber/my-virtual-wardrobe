-- Adds "Bag" to the set of allowed wardrobe_items categories.

alter table public.wardrobe_items drop constraint if exists wardrobe_items_category_check;

alter table public.wardrobe_items
  add constraint wardrobe_items_category_check
  check (
    category in ('Top', 'Bottom', 'Accessory', 'Bag', 'Footwear', 'Outer', 'Swimwear', 'Activewear')
  );
