-- Replace chore_schedule with the weekly chore schedule
delete from public.chore_schedule;

insert into public.chore_schedule (kid_name, chore_name, day_of_week) values
  -- Sunday (0)
  ('Amit', 'Feed dogs',    0),
  ('Ido',  'Kitchen',      0),
  ('Ido',  'Trash',        0),
  ('Ofri', 'Dog poop',     0),

  -- Monday (1)
  ('Amit', 'Trash (curb)', 1),
  ('Amit', 'Dog poop',     1),
  ('Ido',  'Feed dogs',    1),
  ('Ofri', 'Kitchen',      1),

  -- Tuesday (2)
  ('Amit', 'Feed dogs',    2),
  ('Ido',  'Kitchen',      2),
  ('Ofri', 'Trash',        2),
  ('Ofri', 'Dog poop',     2),

  -- Wednesday (3)
  ('Amit', 'Kitchen',      3),
  ('Amit', 'Dog poop',     3),
  ('Ido',  'Trash (curb)', 3),
  ('Ofri', 'Feed dogs',    3),

  -- Thursday (4)
  ('Amit', 'Trash',        4),
  ('Ido',  'Dog poop',     4),
  ('Ofri', 'Kitchen',      4),
  ('Ofri', 'Feed dogs',    4),

  -- Friday (5)
  ('Amit', 'Kitchen',      5),
  ('Ido',  'Dog poop',     5),
  ('Ido',  'Feed dogs',    5),
  ('Ofri', 'Trash',        5),

  -- Saturday (6)
  ('Amit', 'Kitchen',      6),
  ('Amit', 'Feed dogs',    6),
  ('Ido',  'Dog poop',     6),
  ('Ofri', 'Trash (curb)', 6);
