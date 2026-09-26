import type { TextRule } from './types';

/**
 * English text rules.
 *
 * Hard requirements (DETECTION_ENGINE.md §3, §11; audit R14):
 * - never match a raw "ai" substring — word boundaries + explicit phrases;
 * - music/ASMR evidence never claims generated visuals (scoped claims);
 * - bare hashtags are context, not confirmation (DET-05);
 * - AI *discussion* patterns produce opposing evidence to protect legitimate
 *   educational/news/tutorial content about AI;
 * - negation and educational frames are scoped, not global (DET-08/09).
 */
export const EN_RULES: readonly TextRule[] = [
  // ── Creator self-disclosure: explicit generation statements ──────────────
  {
    id: 'en:made-with-ai',
    locale: 'en',
    pattern:
      /\b(made|created|generated|built|filmed|animated)\b[^.!?]{0,40}?\b(with|using|in|by|thanks\s+to)\s+((open\s+)?ai\b|an?\s+A\.?I\.?\b)/i,
    category: 'creator-disclosure',
    strength: 0.85,
    context: 'both',
    claimScope: 'unspecified-generation',
    correlationKey: 'disclosure:generation',
    reasonText: 'The text says it was created with AI.',
  },
  {
    // Visual/video generation tools ONLY — music/audio tools (Suno, Udio,
    // ElevenLabs) are scoped to ai-music/ai-voice rules instead, so naming a
    // music tool never claims generated visuals (DET-11 scoping).
    id: 'en:generated-with-tool',
    locale: 'en',
    pattern:
      /\bgenerated\s+(with|using|in|by)\s+(veo|sora|runway|pika|midjourney|dall-?e|stable\s+diffusion|hey\s?gen|synthesia)\b/i,
    category: 'creator-disclosure',
    strength: 0.9,
    context: 'both',
    claimScope: 'unspecified-generation',
    correlationKey: 'disclosure:generation',
    reasonText: 'The text names the AI tool used to generate it.',
  },
  {
    id: 'en:ai-generated-phrase',
    locale: 'en',
    pattern:
      /\bA\.?I\.?[- ]generated\b|\bgenerative\s+A\.?I\.?\s+(video|film|short|voice|music)\b/i,
    category: 'creator-disclosure',
    strength: 0.8,
    context: 'both',
    claimScope: 'unspecified-generation',
    correlationKey: 'disclosure:generation',
    // DET-08: detection-education frames describe the topic without
    // disclosing provenance — they suppress this disclosure-shaped match.
    suppressedBy: [
      /\bhow\s+to\s+(spot|detect|identify|recognize|find)\b/i,
      /\bways\s+to\s+(spot|detect|identify|recognize|find)\b/i,
      /\bspotting\s+(fake|ai)\b/i,
    ],
    reasonText: 'The text explicitly describes the content as AI-generated.',
  },
  {
    // DET-07: AI-character content ("Cute AI Baby Reciting Papa") is an
    // honest AMBIGUOUS contextual signal — weak, never confirmed provenance.
    id: 'en:ai-character-title',
    locale: 'en',
    pattern:
      /\bA\.?I\.?\s+(baby|babies|kid|kids|child|children|toddler|cat|cats|dog|dogs|pet|pets|animal|animals|monkey|bear)\b/i,
    category: 'ai-visual',
    strength: 0.4,
    context: 'title',
    claimScope: 'visual',
    reasonText:
      'The title references AI-generated character content, an ambiguous contextual signal.',
  },
  {
    id: 'en:ai-voiceover-disclosure',
    locale: 'en',
    pattern: /\b(A\.?I\.?|automated)\s+(voice\s?over|voiceover|narration)\s+(by|using|generated)/i,
    category: 'ai-voice',
    strength: 0.7,
    context: 'description',
    claimScope: 'audio',
    correlationKey: 'disclosure:voice',
    reasonText: 'The description discloses an automated voice-over.',
  },

  // ── Scoped generation claims (visuals/footage named explicitly) ─────────
  {
    id: 'en:visuals-ai-generated',
    locale: 'en',
    pattern:
      /\b(all|the|some)\s+(visuals?|footage|animation|imagery|scenes?)\s+(in\s+this\s+video\s+)?(are|is|was|were)\s+A\.?I\.?\s*-?\s*generated/i,
    category: 'ai-visual',
    strength: 0.8,
    context: 'description',
    claimScope: 'visual',
    correlationKey: 'disclosure:visuals',
    reasonText: 'The description says the visuals are AI-generated.',
  },
  {
    // DET-10: "Tutorial: all footage in this video was generated with Sora"
    // is a DIRECT disclosure — an educational frame must not erase it.
    id: 'en:footage-generated-tool',
    locale: 'en',
    pattern:
      /\b(footage|video|clips?|scenes?)\s+(in\s+(this|the)\s+video\s+)?(was|were|is|are)\s+generated\s+(with|using|in|by)\s+\w+/i,
    category: 'ai-visual',
    strength: 0.85,
    context: 'description',
    claimScope: 'visual',
    correlationKey: 'disclosure:visuals',
    reasonText: 'The description states the footage itself was generated.',
  },

  // ── Music/voice tools: scoped to audio, never visuals (DET-11) ──────────
  {
    id: 'en:ai-music-tool',
    locale: 'en',
    pattern:
      /\b(music|song|track|audio)\s+(was\s+)?(generated|created|made)\s+(with|using|in|by)\s+(suno|udio|eleven\s?labs|A\.?I\.?|an?\s+A\.?I\.?)\b|\bgenerated\s+(with|using|in|by)\s+(suno|udio)\b/i,
    category: 'ai-music',
    strength: 0.75,
    context: 'both',
    claimScope: 'music',
    correlationKey: 'disclosure:music',
    reasonText: 'The text says the music was AI-generated.',
  },
  {
    // DET-01/02: "AI Generated Funny Fruits Animation" is NOT a music claim —
    // this rule requires a music/audio noun so generic "AI generated X"
    // phrases never leak into the music category.
    id: 'en:ai-music-channel',
    locale: 'en',
    pattern:
      /\bA\.?I\.?\s+(generated|made|sung|covers?)\s+(song|music|track|cover|album|single|voice|audio)\b|\b(sung|covered)\s+by\s+A\.?I\.?\b/i,
    category: 'ai-music',
    strength: 0.6,
    context: 'both',
    claimScope: 'music',
    correlationKey: 'disclosure:music',
    reasonText: 'The text attributes the music to AI generation.',
  },

  // ── Title heuristics: contextual generation signals (DET-04/07) ─────────
  {
    id: 'en:asked-ai-title',
    locale: 'en',
    pattern:
      /\bi\s+(asked|told|gave)\s+(chat\s?gpt|gpt[- ]?\d|gemini|claude|copilot|an?\s+A\.?I\.?)\b/i,
    category: 'ai-visual',
    strength: 0.45,
    context: 'title',
    claimScope: 'visual',
    reasonText: 'The title describes prompting an AI to produce content.',
  },
  {
    id: 'en:ai-animation-title',
    locale: 'en',
    pattern: /\bA\.?I\.?\s+(animation|animated)\b|\b(?:3d|3-D)\s+animation\b/i,
    category: 'ai-visual',
    strength: 0.45,
    context: 'title',
    claimScope: 'visual',
    reasonText: 'The title indicates animation likely produced with AI tooling.',
  },
  {
    id: 'en:sleep-relax-ai',
    locale: 'en',
    pattern:
      /\b\d+\s*(hours?|minutes?)\s+of\s+(calming|relaxing|soothing|sleeping)\b.*\b(scenes|footage|views)\b/i,
    category: 'ai-visual',
    strength: 0.4,
    context: 'title',
    claimScope: 'visual',
    reasonText: 'The title matches mass-produced synthetic relaxation content patterns.',
  },

  // ── V4-04 live-sampled family gaps (frozen live sample 2026-09-25): the
  // live slop economy self-labels the MEDIUM — "AI ASMR", "AI Film", "AI
  // video" as a genre noun, and hyphenated tool variants — and none of these
  // families matched any rule. Designed per the DET-07 precedent (ambiguous
  // contextual signal): title-scoped, ai-visual, so aggressive hides at its
  // 0.35 floor while balanced/strict only warn; no metadata is invented.
  {
    id: 'en:ai-asmr-genre',
    locale: 'en',
    pattern: /\bA\.?I\.?[\s-]*ASMR\b/i,
    category: 'ai-visual',
    strength: 0.5,
    context: 'title',
    claimScope: 'visual',
    // DET-08-style scoping: "How to make AI ASMR videos (and monetize)" is a
    // tutorial ABOUT the genre — discussion, not a disclosure of provenance.
    suppressedBy: [
      /\bhow\s+to\s+(make|create|edit|produce|monetize|get\s+started)\b/i,
      /\b(monetize|money|income|revenue)\b/i,
    ],
    reasonText:
      'The title self-labels the medium as AI ASMR, an ambiguous contextual generation signal.',
  },
  {
    id: 'en:ai-film-genre',
    locale: 'en',
    pattern:
      /\bA\.?I\.?[\s-]*(film|movie|cinematic)\b|\bA\.?I\.?\s+short\s+film\b|\bgen[-\s]?A\.?I\.?\s+(short\s+film|film)\b/i,
    category: 'ai-visual',
    strength: 0.5,
    context: 'title',
    claimScope: 'visual',
    suppressedBy: [
      /\bhow\s+to\s+(make|create|edit|produce|get\s+started)\b/i,
      /\b(tutorial|course|guide|master)\b/i,
    ],
    reasonText:
      'The title self-labels the medium as an AI film/movie, an ambiguous contextual generation signal.',
  },

  // ── Slop patterns ────────────────────────────────────────────────────────
  {
    id: 'en:fake-facts-title',
    locale: 'en',
    pattern: /\b(you\s?won'?t\s?believe|scientists\s+hate\s+(this|him|her)|top\s+10\s+shocking)\b/i,
    category: 'clickbait',
    strength: 0.35,
    context: 'title',
    reasonText: 'The title uses classic clickbait phrasing.',
  },
  {
    id: 'en:repetition-loop',
    locale: 'en',
    pattern: /\b(same|identical)\s+(video|scene|clip)\s+(again|for\s+the\s+\d+\w{2}\s+time)\b/i,
    category: 'repetitive',
    strength: 0.3,
    context: 'title',
    reasonText: 'The title indicates repeated/reused content.',
  },

  // ── AI discussion context (opposing evidence — false-positive guard) ─────
  {
    id: 'en:discussion-explainer',
    locale: 'en',
    pattern:
      /\b(how|what|why|when)\s+(do|does|did|is|are|was|were)?\s*(generative\s+)?A\.?I\.?\s+(works?|worked?|is\s?used|affects?|changes?|impacts?)/i,
    category: 'ai-discussion',
    strength: 0.6,
    context: 'title',
    polarity: 'opposes',
    reasonText: 'The title appears to explain or discuss AI rather than present generated content.',
  },
  {
    id: 'en:discussion-analysis',
    locale: 'en',
    pattern:
      /\b(explaining|analysis|review|critique|criticism|dangers?|risks?|impact|future|regulation|policy|news|ethics)\s+of\s+((generative\s+)?A\.?I\.?|artificial\s+intelligence)\b/i,
    category: 'ai-discussion',
    strength: 0.6,
    context: 'title',
    polarity: 'opposes',
    reasonText: 'The title appears to analyze or discuss AI topics.',
  },
  {
    id: 'en:discussion-i-tested',
    locale: 'en',
    pattern:
      /\bI\s+(tested|reviewed|tried)\s+(sora|veo|chat\s?gpt|gemini|claude|midjourney|an?\s+A\.?I\.?\s+video\s+generator)\b/i,
    category: 'ai-discussion',
    strength: 0.55,
    context: 'title',
    polarity: 'opposes',
    reasonText: 'The title suggests a human review/test of an AI tool.',
  },
  {
    id: 'en:discussion-tutorial',
    locale: 'en',
    pattern:
      /\b(tutorial|how\s+to\s+(run|use|install|build))\b.*\b(local\s+LLM|llama|stable\s+diffusion|A\.?I\.?\s+model)\b/i,
    category: 'ai-discussion',
    strength: 0.55,
    context: 'title',
    polarity: 'opposes',
    reasonText: 'The title appears to be a tutorial about AI tools.',
  },
  {
    id: 'en:discussion-essay',
    locale: 'en',
    pattern:
      /\bwhy\s+A\.?I\.?\s+(slop|content|videos?)\s+(is|are)\s+(ruining|taking\s+over|flooding)\b/i,
    category: 'ai-discussion',
    strength: 0.65,
    context: 'title',
    polarity: 'opposes',
    reasonText: 'The title is commentary about AI slop, not generated content itself.',
  },
  {
    id: 'en:discussion-news',
    locale: 'en',
    pattern:
      /\b(artificial\s+intelligence|A\.?I\.?)\s+(regulation|hearing|laws?|bill|policy|summit|safety)\b/i,
    category: 'ai-discussion',
    strength: 0.6,
    context: 'title',
    polarity: 'opposes',
    reasonText: 'The title refers to AI policy/news topics.',
  },
  {
    id: 'en:discussion-spotting',
    locale: 'en',
    pattern:
      /\b(how|ways)\s+to\s+(spot|detect|identify|recognize)\s+(an?\s+)?A\.?I\.?[- ]generated?\b/i,
    category: 'ai-discussion',
    strength: 0.65,
    context: 'both',
    polarity: 'opposes',
    reasonText: 'The title is about detecting AI content — a discussion, not a disclosure.',
  },

  // ── N09 regression additions (corpus misses c007/c010/c011/c013/c025/...)
  // Tool-name co-anchors: a title naming BOTH "made"-class verbs and an AI
  // video tool without the strict "generated with" word order. Scoped to
  // explicit tool nouns so ordinary prose never matches.
  {
    id: 'en:made-with-video-tool',
    locale: 'en',
    pattern:
      /\b(made|created|filmed|shot)\b[^.!?]{0,30}?\b(with|using|in|by)\s+(veo|sora|runway|pika(\s?labs)?|midjourney|dall-?e|stable\s+diffusion|synthesia|hey\s?gen|gen-?\d)\b/i,
    category: 'creator-disclosure',
    strength: 0.85,
    context: 'both',
    claimScope: 'unspecified-generation',
    correlationKey: 'disclosure:generation',
    reasonText: 'The text says it was made with an AI video tool.',
  },
  {
    // "Created with OpenAI Sora" — vendor-prefixed tool names.
    id: 'en:created-with-vendor-tool',
    locale: 'en',
    pattern:
      /\b(created|generated|made)\s+(with|using|by|in)\s+(open\s?ai\s+)?(sora|veo|runway|pika(\s?labs)?|midjourney|dall-?e)\b/i,
    category: 'creator-disclosure',
    strength: 0.85,
    context: 'both',
    claimScope: 'unspecified-generation',
    correlationKey: 'disclosure:generation',
    reasonText: 'The text names the AI tool used to create it.',
  },
  {
    id: 'en:disclosure-parens',
    locale: 'en',
    pattern:
      /\((made|created|generated)\s+with\s+AI\)|\(AI\s*[-–]?\s*generated\)|\bwith\s+AI\s+video\s+tools\b/i,
    category: 'creator-disclosure',
    strength: 0.8,
    context: 'both',
    claimScope: 'unspecified-generation',
    correlationKey: 'disclosure:generation',
    reasonText: 'The title carries an explicit AI parenthetical disclosure.',
  },
  {
    // "hosted by an AI avatar" / "AI avatar" — synthetic presenter.
    id: 'en:ai-avatar',
    locale: 'en',
    pattern: /\b(A\.?I\.?|virtual|synthetic)\s+(avatar|presenter|influencer|news\s*anchor)\b/i,
    category: 'ai-visual',
    strength: 0.6,
    context: 'both',
    claimScope: 'visual',
    reasonText: 'The text describes an AI-generated presenter or avatar.',
  },
  {
    // "fully AI video" / "entirely with AI voices" — whole-content claims.
    id: 'en:fully-ai-content',
    locale: 'en',
    pattern:
      /\b(fully|entirely|completely)\s+(with\s+)?A\.?I\.?(\s+(video|voices?|generated|made))?\b|\ball\s+AI\b/i,
    category: 'ai-unspecified',
    strength: 0.6,
    context: 'both',
    claimScope: 'unspecified-generation',
    reasonText: 'The text claims the whole content is AI-produced.',
  },
  {
    // N09 multilingual misses (ja/es): explicit localized disclosure phrases
    // observed in the corpus. Patterns match the disclosed phrases only.
    id: 'multilingual:ja-ai-disclosure',
    locale: 'en',
    pattern: /AI\u52d5\u753b|AI\u6620\u50cf|AI\u3067\u4f5c\u308b|AI\u751f\u6210/i,
    category: 'creator-disclosure',
    strength: 0.8,
    context: 'both',
    claimScope: 'unspecified-generation',
    correlationKey: 'disclosure:generation',
    reasonText: 'The text discloses AI-generated video (Japanese).',
  },
  {
    id: 'multilingual:es-ai-disclosure',
    locale: 'en',
    pattern: /\bhecho\s+con\s+IA\b|\bgenerada?\s+con\s+IA\b|\bvideo\s+hecho\s+con\s+IA\b/i,
    category: 'creator-disclosure',
    strength: 0.8,
    context: 'both',
    claimScope: 'unspecified-generation',
    correlationKey: 'disclosure:generation',
    reasonText: 'The text discloses AI-generated content (Spanish).',
  },
  {
    id: 'multilingual:suno-ia',
    locale: 'en',
    pattern: /\bgenerada\s+con\s+Suno\b/i,
    category: 'ai-music',
    strength: 0.7,
    context: 'both',
    claimScope: 'music',
    correlationKey: 'disclosure:music',
    reasonText: 'The text says the music was generated with Suno.',
  },
  // ── Shorts title patterns (N09 misses c058/c059/c156/c158) ─────────────
  {
    id: 'en:shorts-ai-character',
    locale: 'en',
    pattern:
      /\bA\.?I\.?\s+(baby|babies|chef|professor|presenter)\b.*#shorts|#shorts.*\bA\.?I\.?\s+(baby|babies|chef|professor|presenter)\b/i,
    category: 'ai-visual',
    strength: 0.55,
    context: 'title',
    claimScope: 'visual',
    reasonText: 'The title references AI character content in a Short.',
  },
];
