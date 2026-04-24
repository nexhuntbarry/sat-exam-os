-- SAT Exam OS — Phase 1 Seed
-- SAT domain reference data

CREATE TABLE IF NOT EXISTS sat_domains (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section     text NOT NULL,
  name        text NOT NULL,
  sort_order  int NOT NULL
);

INSERT INTO sat_domains (section, name, sort_order) VALUES
  -- Reading & Writing domains
  ('Reading & Writing', 'Information and Ideas',           1),
  ('Reading & Writing', 'Craft and Structure',             2),
  ('Reading & Writing', 'Expression of Ideas',             3),
  ('Reading & Writing', 'Standard English Conventions',    4),
  -- Math domains
  ('Math', 'Algebra',                                      5),
  ('Math', 'Advanced Math',                                6),
  ('Math', 'Problem Solving and Data Analysis',            7),
  ('Math', 'Geometry and Trigonometry',                    8)
ON CONFLICT DO NOTHING;
