-- GENERATED FILE: scripts/render-task7-menu-seed.cjs. Do not edit by hand.
-- Task 7 fictional sample menu (task7-menu-v1): 33 items, 119 category/tag rows, 10 merchants.
-- Review only. Run Database/migrations/005_task7_menu_items.sql first (and the Task 3 seed).
-- Stages every expected row in temporary tables, validates ownership and collisions, and only then changes permanent
-- data in ONE transaction that rolls back completely on any failure. An identical rerun changes nothing.
-- It only inserts rows into merchant_menu_items and merchant_menu_item_terms. It never writes merchants, users,
-- transactions, activity, feedback or campaigns, and never deletes. All dietary flags are fictional and unverified.

USE NetsVouch;

DROP TEMPORARY TABLE IF EXISTS tmp_task7_terms;
DROP TEMPORARY TABLE IF EXISTS tmp_task7_items;

CREATE TEMPORARY TABLE tmp_task7_items (
  item_id VARCHAR(96) NOT NULL PRIMARY KEY,
  merchant_id VARCHAR(64) NOT NULL,
  item_slug VARCHAR(64) NOT NULL,
  item_name VARCHAR(100) NOT NULL,
  price DECIMAL(6,2) NOT NULL,
  is_vegetarian TINYINT(1) NULL,
  is_vegan TINYINT(1) NULL,
  is_halal TINYINT(1) NULL,
  sort_order SMALLINT UNSIGNED NOT NULL
);
INSERT INTO tmp_task7_items (item_id, merchant_id, item_slug, item_name, price, is_vegetarian, is_vegan, is_halal, sort_order) VALUES
('felicia-chicken-rice--roasted-chicken-rice', 'felicia-chicken-rice', 'roasted-chicken-rice', 'Roasted Chicken Rice', 5.00, NULL, NULL, 1, 1),
('felicia-chicken-rice--steamed-chicken-rice', 'felicia-chicken-rice', 'steamed-chicken-rice', 'Steamed Chicken Rice', 5.00, NULL, NULL, 1, 2),
('felicia-chicken-rice--chicken-drumstick-rice', 'felicia-chicken-rice', 'chicken-drumstick-rice', 'Chicken Drumstick Rice', 6.20, NULL, NULL, 1, 3),
('green-bowl--tofu-quinoa-bowl', 'green-bowl', 'tofu-quinoa-bowl', 'Tofu Quinoa Bowl', 7.50, 1, 1, NULL, 1),
('green-bowl--chicken-teriyaki-grain-bowl', 'green-bowl', 'chicken-teriyaki-grain-bowl', 'Chicken Teriyaki Grain Bowl', 8.20, NULL, NULL, NULL, 2),
('green-bowl--hummus-veggie-wrap', 'green-bowl', 'hummus-veggie-wrap', 'Hummus Veggie Wrap', 6.80, 1, 1, NULL, 3),
('green-bowl--pumpkin-brown-rice', 'green-bowl', 'pumpkin-brown-rice', 'Pumpkin Brown Rice', 6.50, 1, 1, NULL, 4),
('woodlands-noodle-bar--wanton-noodle', 'woodlands-noodle-bar', 'wanton-noodle', 'Wanton Noodle', 6.00, NULL, NULL, NULL, 1),
('woodlands-noodle-bar--chicken-mee-pok', 'woodlands-noodle-bar', 'chicken-mee-pok', 'Chicken Mee Pok', 6.00, NULL, NULL, NULL, 2),
('woodlands-noodle-bar--chicken-noodle-soup', 'woodlands-noodle-bar', 'chicken-noodle-soup', 'Chicken Noodle Soup', 6.50, NULL, NULL, NULL, 3),
('northside-wraps--chicken-shawarma-wrap', 'northside-wraps', 'chicken-shawarma-wrap', 'Chicken Shawarma Wrap', 6.80, NULL, NULL, 1, 1),
('northside-wraps--beef-kebab-wrap', 'northside-wraps', 'beef-kebab-wrap', 'Beef Kebab Wrap', 7.20, NULL, NULL, 1, 2),
('northside-wraps--grilled-chicken-wrap', 'northside-wraps', 'grilled-chicken-wrap', 'Grilled Chicken Wrap', 7.00, NULL, NULL, 1, 3),
('spice-lane--chicken-briyani', 'spice-lane', 'chicken-briyani', 'Chicken Briyani', 7.50, NULL, NULL, 1, 1),
('spice-lane--butter-chicken-naan', 'spice-lane', 'butter-chicken-naan', 'Butter Chicken & Naan', 8.50, NULL, NULL, 1, 2),
('spice-lane--dhal-roti-prata-set', 'spice-lane', 'dhal-roti-prata-set', 'Dhal & Roti Prata Set', 6.50, 1, NULL, 1, 3),
('spice-lane--vegetable-curry-rice', 'spice-lane', 'vegetable-curry-rice', 'Vegetable Curry Rice', 7.00, 1, NULL, 1, 4),
('makcik-nasi-padang--ayam-goreng-rice-set', 'makcik-nasi-padang', 'ayam-goreng-rice-set', 'Ayam Goreng Rice Set', 5.50, NULL, NULL, 1, 1),
('makcik-nasi-padang--beef-rendang-rice', 'makcik-nasi-padang', 'beef-rendang-rice', 'Beef Rendang Rice', 6.50, NULL, NULL, 1, 2),
('makcik-nasi-padang--mee-soto', 'makcik-nasi-padang', 'mee-soto', 'Mee Soto', 5.00, NULL, NULL, 1, 3),
('tokyo-express-bento--chicken-teriyaki-donburi', 'tokyo-express-bento', 'chicken-teriyaki-donburi', 'Chicken Teriyaki Donburi', 8.90, NULL, NULL, NULL, 1),
('tokyo-express-bento--salmon-poke-bowl', 'tokyo-express-bento', 'salmon-poke-bowl', 'Salmon Poke Bowl', 9.50, NULL, NULL, NULL, 2),
('tokyo-express-bento--cold-soba-set', 'tokyo-express-bento', 'cold-soba-set', 'Cold Soba Set', 8.50, NULL, NULL, NULL, 3),
('ah-heng-fish-soup--sliced-fish-soup-set', 'ah-heng-fish-soup', 'sliced-fish-soup-set', 'Sliced Fish Soup Set', 5.20, NULL, NULL, NULL, 1),
('ah-heng-fish-soup--fish-soup-bee-hoon', 'ah-heng-fish-soup', 'fish-soup-bee-hoon', 'Fish Soup Bee Hoon', 5.50, NULL, NULL, NULL, 2),
('vegan-zen-kitchen--mushroom-rice-bowl', 'vegan-zen-kitchen', 'mushroom-rice-bowl', 'Mushroom Rice Bowl', 9.50, 1, 1, NULL, 1),
('vegan-zen-kitchen--vegan-mee-goreng', 'vegan-zen-kitchen', 'vegan-mee-goreng', 'Vegan Mee Goreng', 8.50, 1, 1, NULL, 2),
('vegan-zen-kitchen--lettuce-wrap-trio', 'vegan-zen-kitchen', 'lettuce-wrap-trio', 'Lettuce Wrap Trio', 9.00, 1, 1, NULL, 3),
('vegan-zen-kitchen--vegan-laksa', 'vegan-zen-kitchen', 'vegan-laksa', 'Vegan Laksa', 9.20, 1, 1, NULL, 4),
('kopi-toast-corner--kaya-butter-toast-set', 'kopi-toast-corner', 'kaya-butter-toast-set', 'Kaya Butter Toast Set', 4.50, 1, NULL, 1, 1),
('kopi-toast-corner--soft-boiled-eggs-toast', 'kopi-toast-corner', 'soft-boiled-eggs-toast', 'Soft-boiled Eggs & Toast', 4.80, 1, NULL, 1, 2),
('kopi-toast-corner--roti-prata-kosong', 'kopi-toast-corner', 'roti-prata-kosong', 'Roti Prata Kosong', 3.50, 1, NULL, 1, 3),
('kopi-toast-corner--mee-siam', 'kopi-toast-corner', 'mee-siam', 'Mee Siam', 4.50, NULL, NULL, 1, 4);

CREATE TEMPORARY TABLE tmp_task7_terms (
  item_id VARCHAR(96) NOT NULL,
  term_kind ENUM('category','tag') NOT NULL,
  term VARCHAR(40) NOT NULL,
  PRIMARY KEY (item_id, term_kind, term)
);
INSERT INTO tmp_task7_terms (item_id, term_kind, term) VALUES
('felicia-chicken-rice--roasted-chicken-rice', 'category', 'rice'),
('felicia-chicken-rice--roasted-chicken-rice', 'tag', 'chicken'),
('felicia-chicken-rice--roasted-chicken-rice', 'tag', 'chicken-rice'),
('felicia-chicken-rice--steamed-chicken-rice', 'category', 'rice'),
('felicia-chicken-rice--steamed-chicken-rice', 'tag', 'chicken'),
('felicia-chicken-rice--steamed-chicken-rice', 'tag', 'chicken-rice'),
('felicia-chicken-rice--steamed-chicken-rice', 'tag', 'light'),
('felicia-chicken-rice--chicken-drumstick-rice', 'category', 'rice'),
('felicia-chicken-rice--chicken-drumstick-rice', 'tag', 'chicken'),
('green-bowl--tofu-quinoa-bowl', 'category', 'healthy-bowls'),
('green-bowl--tofu-quinoa-bowl', 'tag', 'tofu'),
('green-bowl--tofu-quinoa-bowl', 'tag', 'quinoa'),
('green-bowl--tofu-quinoa-bowl', 'tag', 'light'),
('green-bowl--chicken-teriyaki-grain-bowl', 'category', 'healthy-bowls'),
('green-bowl--chicken-teriyaki-grain-bowl', 'tag', 'chicken'),
('green-bowl--chicken-teriyaki-grain-bowl', 'tag', 'teriyaki'),
('green-bowl--chicken-teriyaki-grain-bowl', 'tag', 'light'),
('green-bowl--hummus-veggie-wrap', 'category', 'wraps'),
('green-bowl--hummus-veggie-wrap', 'tag', 'hummus'),
('green-bowl--hummus-veggie-wrap', 'tag', 'vegetables'),
('green-bowl--hummus-veggie-wrap', 'tag', 'light'),
('green-bowl--pumpkin-brown-rice', 'category', 'rice'),
('green-bowl--pumpkin-brown-rice', 'tag', 'pumpkin'),
('green-bowl--pumpkin-brown-rice', 'tag', 'vegetables'),
('woodlands-noodle-bar--wanton-noodle', 'category', 'noodles'),
('woodlands-noodle-bar--wanton-noodle', 'tag', 'wanton'),
('woodlands-noodle-bar--wanton-noodle', 'tag', 'pork'),
('woodlands-noodle-bar--chicken-mee-pok', 'category', 'noodles'),
('woodlands-noodle-bar--chicken-mee-pok', 'tag', 'chicken'),
('woodlands-noodle-bar--chicken-mee-pok', 'tag', 'mee-pok'),
('woodlands-noodle-bar--chicken-noodle-soup', 'category', 'noodles'),
('woodlands-noodle-bar--chicken-noodle-soup', 'category', 'soup'),
('woodlands-noodle-bar--chicken-noodle-soup', 'tag', 'chicken'),
('northside-wraps--chicken-shawarma-wrap', 'category', 'wraps'),
('northside-wraps--chicken-shawarma-wrap', 'tag', 'chicken'),
('northside-wraps--chicken-shawarma-wrap', 'tag', 'shawarma'),
('northside-wraps--beef-kebab-wrap', 'category', 'wraps'),
('northside-wraps--beef-kebab-wrap', 'tag', 'beef'),
('northside-wraps--beef-kebab-wrap', 'tag', 'kebab'),
('northside-wraps--grilled-chicken-wrap', 'category', 'wraps'),
('northside-wraps--grilled-chicken-wrap', 'tag', 'chicken'),
('northside-wraps--grilled-chicken-wrap', 'tag', 'grilled'),
('northside-wraps--grilled-chicken-wrap', 'tag', 'light'),
('spice-lane--chicken-briyani', 'category', 'rice'),
('spice-lane--chicken-briyani', 'category', 'indian'),
('spice-lane--chicken-briyani', 'tag', 'chicken'),
('spice-lane--chicken-briyani', 'tag', 'briyani'),
('spice-lane--chicken-briyani', 'tag', 'spicy'),
('spice-lane--butter-chicken-naan', 'category', 'indian'),
('spice-lane--butter-chicken-naan', 'category', 'bread'),
('spice-lane--butter-chicken-naan', 'tag', 'chicken'),
('spice-lane--butter-chicken-naan', 'tag', 'curry'),
('spice-lane--butter-chicken-naan', 'tag', 'naan'),
('spice-lane--dhal-roti-prata-set', 'category', 'indian'),
('spice-lane--dhal-roti-prata-set', 'category', 'bread'),
('spice-lane--dhal-roti-prata-set', 'tag', 'dhal'),
('spice-lane--dhal-roti-prata-set', 'tag', 'prata'),
('spice-lane--vegetable-curry-rice', 'category', 'rice'),
('spice-lane--vegetable-curry-rice', 'category', 'indian'),
('spice-lane--vegetable-curry-rice', 'tag', 'curry'),
('spice-lane--vegetable-curry-rice', 'tag', 'vegetables'),
('makcik-nasi-padang--ayam-goreng-rice-set', 'category', 'rice'),
('makcik-nasi-padang--ayam-goreng-rice-set', 'tag', 'chicken'),
('makcik-nasi-padang--ayam-goreng-rice-set', 'tag', 'ayam-goreng'),
('makcik-nasi-padang--ayam-goreng-rice-set', 'tag', 'fried'),
('makcik-nasi-padang--beef-rendang-rice', 'category', 'rice'),
('makcik-nasi-padang--beef-rendang-rice', 'tag', 'beef'),
('makcik-nasi-padang--beef-rendang-rice', 'tag', 'rendang'),
('makcik-nasi-padang--mee-soto', 'category', 'noodles'),
('makcik-nasi-padang--mee-soto', 'category', 'soup'),
('makcik-nasi-padang--mee-soto', 'tag', 'chicken'),
('makcik-nasi-padang--mee-soto', 'tag', 'soto'),
('tokyo-express-bento--chicken-teriyaki-donburi', 'category', 'rice'),
('tokyo-express-bento--chicken-teriyaki-donburi', 'tag', 'chicken'),
('tokyo-express-bento--chicken-teriyaki-donburi', 'tag', 'teriyaki'),
('tokyo-express-bento--chicken-teriyaki-donburi', 'tag', 'donburi'),
('tokyo-express-bento--salmon-poke-bowl', 'category', 'healthy-bowls'),
('tokyo-express-bento--salmon-poke-bowl', 'tag', 'salmon'),
('tokyo-express-bento--salmon-poke-bowl', 'tag', 'fish'),
('tokyo-express-bento--salmon-poke-bowl', 'tag', 'light'),
('tokyo-express-bento--cold-soba-set', 'category', 'noodles'),
('tokyo-express-bento--cold-soba-set', 'tag', 'soba'),
('tokyo-express-bento--cold-soba-set', 'tag', 'light'),
('ah-heng-fish-soup--sliced-fish-soup-set', 'category', 'soup'),
('ah-heng-fish-soup--sliced-fish-soup-set', 'category', 'rice'),
('ah-heng-fish-soup--sliced-fish-soup-set', 'tag', 'fish'),
('ah-heng-fish-soup--sliced-fish-soup-set', 'tag', 'light'),
('ah-heng-fish-soup--sliced-fish-soup-set', 'tag', 'clear-soup'),
('ah-heng-fish-soup--fish-soup-bee-hoon', 'category', 'noodles'),
('ah-heng-fish-soup--fish-soup-bee-hoon', 'category', 'soup'),
('ah-heng-fish-soup--fish-soup-bee-hoon', 'tag', 'fish'),
('ah-heng-fish-soup--fish-soup-bee-hoon', 'tag', 'bee-hoon'),
('ah-heng-fish-soup--fish-soup-bee-hoon', 'tag', 'light'),
('vegan-zen-kitchen--mushroom-rice-bowl', 'category', 'rice'),
('vegan-zen-kitchen--mushroom-rice-bowl', 'category', 'healthy-bowls'),
('vegan-zen-kitchen--mushroom-rice-bowl', 'tag', 'mushroom'),
('vegan-zen-kitchen--mushroom-rice-bowl', 'tag', 'light'),
('vegan-zen-kitchen--vegan-mee-goreng', 'category', 'noodles'),
('vegan-zen-kitchen--vegan-mee-goreng', 'tag', 'vegetables'),
('vegan-zen-kitchen--vegan-mee-goreng', 'tag', 'spicy'),
('vegan-zen-kitchen--lettuce-wrap-trio', 'category', 'wraps'),
('vegan-zen-kitchen--lettuce-wrap-trio', 'tag', 'tofu'),
('vegan-zen-kitchen--lettuce-wrap-trio', 'tag', 'light'),
('vegan-zen-kitchen--vegan-laksa', 'category', 'noodles'),
('vegan-zen-kitchen--vegan-laksa', 'category', 'soup'),
('vegan-zen-kitchen--vegan-laksa', 'tag', 'spicy'),
('vegan-zen-kitchen--vegan-laksa', 'tag', 'coconut'),
('kopi-toast-corner--kaya-butter-toast-set', 'category', 'bread'),
('kopi-toast-corner--kaya-butter-toast-set', 'tag', 'toast'),
('kopi-toast-corner--kaya-butter-toast-set', 'tag', 'kaya'),
('kopi-toast-corner--soft-boiled-eggs-toast', 'category', 'bread'),
('kopi-toast-corner--soft-boiled-eggs-toast', 'tag', 'egg'),
('kopi-toast-corner--soft-boiled-eggs-toast', 'tag', 'toast'),
('kopi-toast-corner--soft-boiled-eggs-toast', 'tag', 'light'),
('kopi-toast-corner--roti-prata-kosong', 'category', 'indian'),
('kopi-toast-corner--roti-prata-kosong', 'category', 'bread'),
('kopi-toast-corner--roti-prata-kosong', 'tag', 'prata'),
('kopi-toast-corner--mee-siam', 'category', 'noodles'),
('kopi-toast-corner--mee-siam', 'tag', 'spicy');

DELIMITER //
DROP PROCEDURE IF EXISTS task7_seed_menu_v1//
CREATE PROCEDURE task7_seed_menu_v1()
BEGIN
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  IF (SELECT COUNT(*) FROM tmp_task7_items) <> 33 OR (SELECT COUNT(*) FROM tmp_task7_terms) <> 119 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu seed: staged definition has unexpected cardinality';
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('merchant_menu_items', 'merchant_menu_item_terms')) <> 2 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu seed: migration 005 has not been installed';
  END IF;

  START TRANSACTION;

  IF EXISTS (SELECT 1 FROM tmp_task7_items t LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
             WHERE m.merchant_id IS NULL OR m.sample_dataset_key IS NULL OR m.sample_dataset_key <> 'nets-vouch-task3-v1' OR m.is_sample_data <> 1) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu seed: a merchant is missing or is not an owned sample merchant';
  END IF;
  IF EXISTS (SELECT 1 FROM tmp_task7_items t JOIN merchants m ON m.merchant_id = t.merchant_id
             WHERE (t.is_halal IS NOT NULL AND IFNULL(m.dietary_halal, 0) <> 1)
                OR (t.is_vegetarian IS NOT NULL AND IFNULL(m.dietary_vegetarian, 0) + IFNULL(m.dietary_vegan, 0) = 0)
                OR (t.is_vegan IS NOT NULL AND IFNULL(m.dietary_vegan, 0) <> 1)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu seed: an item dietary flag exceeds what its merchant supports';
  END IF;
  IF EXISTS (SELECT 1 FROM merchant_menu_items e JOIN tmp_task7_items t ON t.item_id = e.item_id
             WHERE NOT (e.merchant_id = t.merchant_id AND e.item_slug = t.item_slug AND e.item_name = t.item_name AND e.price = t.price
                        AND e.is_vegetarian <=> t.is_vegetarian AND e.is_vegan <=> t.is_vegan AND e.is_halal <=> t.is_halal
                        AND e.sort_order = t.sort_order AND e.availability = 'AVAILABLE' AND e.dataset_key = 'nets-vouch-task3-v1' AND e.menu_version = 'task7-menu-v1')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu seed: an item ID collides with a non-owned or differing item';
  END IF;
  IF EXISTS (SELECT 1 FROM merchant_menu_items e LEFT JOIN tmp_task7_items t ON t.item_id = e.item_id
             WHERE e.dataset_key = 'nets-vouch-task3-v1' AND e.menu_version = 'task7-menu-v1' AND t.item_id IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu seed: the owned menu contains items missing from the definition (use a new menu version)';
  END IF;
  IF EXISTS (SELECT 1 FROM merchant_menu_item_terms e JOIN merchant_menu_items i ON i.item_id = e.item_id
             LEFT JOIN tmp_task7_terms t ON t.item_id = e.item_id AND t.term_kind = e.term_kind AND t.term = e.term
             WHERE i.dataset_key = 'nets-vouch-task3-v1' AND i.menu_version = 'task7-menu-v1' AND t.item_id IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu seed: an owned item has category/tag rows missing from the definition';
  END IF;

  INSERT INTO merchant_menu_items (item_id, merchant_id, item_slug, item_name, price, is_vegetarian, is_vegan, is_halal,
                                   availability, dietary_claim_status, is_sample_data, dataset_key, menu_version, sort_order)
  SELECT t.item_id, t.merchant_id, t.item_slug, t.item_name, t.price, t.is_vegetarian, t.is_vegan, t.is_halal,
         'AVAILABLE', 'sample-unverified', 1, 'nets-vouch-task3-v1', 'task7-menu-v1', t.sort_order
    FROM tmp_task7_items t
   WHERE NOT EXISTS (SELECT 1 FROM merchant_menu_items e WHERE e.item_id = t.item_id);
  INSERT INTO merchant_menu_item_terms (item_id, term_kind, term)
  SELECT t.item_id, t.term_kind, t.term
    FROM tmp_task7_terms t
   WHERE NOT EXISTS (SELECT 1 FROM merchant_menu_item_terms e WHERE e.item_id = t.item_id AND e.term_kind = t.term_kind AND e.term = t.term);

  IF (SELECT COUNT(*) FROM merchant_menu_items WHERE dataset_key = 'nets-vouch-task3-v1' AND menu_version = 'task7-menu-v1') <> 33 OR
     (SELECT COUNT(*) FROM merchant_menu_item_terms e JOIN merchant_menu_items i ON i.item_id = e.item_id WHERE i.dataset_key = 'nets-vouch-task3-v1' AND i.menu_version = 'task7-menu-v1') <> 119 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu seed: post-install counts differ from the definition';
  END IF;
  IF EXISTS (SELECT 1 FROM merchants m WHERE m.sample_dataset_key = 'nets-vouch-task3-v1' AND
             ((m.dietary_halal = 1 AND NOT EXISTS (SELECT 1 FROM merchant_menu_items i WHERE i.merchant_id = m.merchant_id AND i.is_halal = 1))
           OR (m.dietary_vegetarian = 1 AND NOT EXISTS (SELECT 1 FROM merchant_menu_items i WHERE i.merchant_id = m.merchant_id AND i.is_vegetarian = 1))
           OR (m.dietary_vegan = 1 AND NOT EXISTS (SELECT 1 FROM merchant_menu_items i WHERE i.merchant_id = m.merchant_id AND i.is_vegan = 1)))) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu seed: a merchant supports a dietary option but has no qualifying sample item';
  END IF;

  COMMIT;
END//
CALL task7_seed_menu_v1()//
DROP PROCEDURE task7_seed_menu_v1//
DELIMITER ;
