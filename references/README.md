# Reference Sets

This directory stores comparison-reference assets for the quality workflow.

## Layout
```text
references/
|- other_images/
|  `- <reference_set_id>/
|- extracted/
|  `- <reference_set_id>/
|- comparisons/
|  `- <reference_set_id>/
`- manifests/
   `- <reference_set_id>.json
```

## Rules
- Put other-translation images into `other_images/<reference_set_id>/`
- Put one manifest file into `manifests/<reference_set_id>.json`
- Extracted text output for the reference set must go into `extracted/<reference_set_id>/`
- Comparison output must go into `comparisons/<reference_set_id>/`
- If you want the reference to become reusable translation assets, run reference ingestion after extraction

## Next Step
When reference images are ready, place them under:

```text
references/other_images/<reference_set_id>/
```

and add the matching manifest:

```text
references/manifests/<reference_set_id>.json
```

## AVIF Conversion Helper
If a reference set contains AVIF payloads with misleading file extensions such as `.jpg`,
convert them into a backend-safe reference set with:

```bash
node backend/scripts/convert_reference_images.js --reference-set-id ref_001
```

By default this creates:
- `references/other_images/ref_001_converted/`
- `references/manifests/ref_001_converted.json`

You can then use `ref_001_converted` for extraction and quality comparison.

## Reference Ingestion
After extraction, promote the reference into manga-scoped translation assets with:

```http
POST /jobs/reference-ingestion
Content-Type: application/json

{
  "referenceSetId": "ref_001",
  "mangaId": "phantom_fantasy",
  "chapterId": "ch_001",
  "glossaryMode": "canonical"
}
```

This writes:
- `knowledge_base/self/<mangaId>/canonical_glossary.json`
- `knowledge_base/self/<mangaId>/story_context.json`
- `knowledge_base/self/<mangaId>/style_profile.json`
