-- Phase 1B+ — Question image extraction
--
-- The PDF parser now returns AI-detected bounding boxes for each image,
-- graph, diagram, or table inside a question. The server crops those
-- regions out of the PDF, uploads them to a public Vercel Blob store,
-- and stores the resulting URLs (and alt-text) on the question row so
-- the question is self-contained in the bank — no PDF reference needed
-- to render it for students/teachers.

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS image_urls text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS image_alts text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN questions.image_urls IS 'Public URLs of cropped images extracted from the source PDF.';
COMMENT ON COLUMN questions.image_alts IS 'AI-generated alt text for each image in image_urls (parallel array).';
