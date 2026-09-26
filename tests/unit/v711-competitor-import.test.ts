import { describe, expect, it } from 'vitest';
import {
  previewCompetitorImport,
  applyCompetitorImport,
  revertCompetitorImport,
  CompetitorImportRejectedError,
} from '@/domain/competitor-import';
import { defaultRules } from '@/domain/rules';

const UC_OK = 'UCX12345678901234567890a'; // 24 chars, UC-prefixed
const UC_OK_2 = 'UCb09876543210987654321c';

describe('V7-11: BlockTube import preview (mapping report, nothing applied)', () => {
  it('maps channel ids, video ids and keywords; reports duplicates and name-only channels as unresolved', () => {
    const json = JSON.stringify({
      blockedChannels: [UC_OK, UC_OK.toLowerCase(), 'BadChannelName'],
      blockedVideos: ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      blockedKeywords: ['slop', '  slop  ', '#shorts'],
      blockedChannelsRegex: ['^UC_.*'],
    });
    const report = previewCompetitorImport(json, 'blocktube', 'blocktube.json');

    expect(report.format).toBe('blocktube');
    expect(report.mapped.channelIds).toEqual([UC_OK]);
    expect(report.mapped.videoIds).toEqual(['dQw4w9WgXcQ']);
    expect(report.mapped.phrases.map((p) => p.phrase)).toEqual(['slop', '#shorts']);
    // Channel NAMES are not unique/verified identities — never mapped to a
    // UC-id rule; reported as unresolved.
    expect(report.unresolvedChannels).toEqual(['BadChannelName']);
    expect(report.duplicates.channelIds).toBe(1);
    expect(report.duplicates.videoIds).toBe(1);
    expect(report.duplicates.phrases).toBe(1);
    // Regex rules are unsupported by design (literal-only matching).
    expect(report.unsupported.some((u) => u.startsWith('regex'))).toBe(true);
    expect(report.licenseNote).toContain('GPLv3');
    // File is PREVIEWED only — the rules object passed in stays untouched.
    expect(report.applied).toBe(false);
  });

  it('maps FilterTube filters: keyword partial→phrase, whole→whole-word, channels and @handles', () => {
    const json = JSON.stringify({
      filters: {
        keywords: [
          { text: 'reaction', wholeWord: false },
          { text: 'gene', wholeWord: true },
        ],
        channels: [{ value: UC_OK_2 }, { value: '@somehandle' }, { value: 'Just A Name' }],
      },
    });
    const report = previewCompetitorImport(json, 'filtertube', 'filters.json');

    expect(report.format).toBe('filtertube');
    expect(report.mapped.channelIds).toEqual([UC_OK_2]);
    expect(report.mapped.handles).toEqual(['@somehandle']);
    expect(report.unresolvedChannels).toEqual(['Just A Name']);
    expect(report.mapped.phrases).toEqual([
      { phrase: 'reaction', wholeWord: false },
      { phrase: 'gene', wholeWord: true },
    ]);
  });

  it('sniffs the format when the caller passes auto', () => {
    const blocktube = previewCompetitorImport(
      JSON.stringify({ blockedChannels: [UC_OK] }),
      'auto',
      'whatever.json',
    );
    expect(blocktube.format).toBe('blocktube');

    const filtertube = previewCompetitorImport(
      JSON.stringify({ filters: { keywords: [{ text: 'x' }] } }),
      'auto',
      'whatever.json',
    );
    expect(filtertube.format).toBe('filtertube');
  });

  it('rejects corrupt JSON, unknown shapes, and oversized files without applying anything', () => {
    expect(() => previewCompetitorImport('{not json', 'auto', 'x.json')).toThrow(
      CompetitorImportRejectedError,
    );
    expect(() => previewCompetitorImport('[]', 'auto', 'x.json')).toThrow(
      CompetitorImportRejectedError,
    );
    expect(() => previewCompetitorImport('{"totally":"other"}', 'auto', 'x.json')).toThrow(
      CompetitorImportRejectedError,
    );
    expect(() =>
      previewCompetitorImport('"' + 'x'.repeat(2_000_001) + '"', 'auto', 'big.json'),
    ).toThrow(CompetitorImportRejectedError);
  });

  it('reports an empty mapping honestly (nothing usable) instead of applying silence', () => {
    const report = previewCompetitorImport(
      JSON.stringify({ blockedChannels: ['Only A Name'] }),
      'blocktube',
      'x.json',
    );
    expect(report.isEmpty).toBe(true);
  });
});

describe('V7-11: explicit apply + rollback (transactional)', () => {
  it('apply merges on top of existing rules and returns a revert snapshot that restores them exactly', () => {
    const base = defaultRules();
    base.blockedPhrases = ['preexisting'];
    base.blockedChannelIds = [UC_OK_2];

    const report = previewCompetitorImport(
      JSON.stringify({ blockedChannels: [UC_OK], blockedKeywords: ['slop'] }),
      'blocktube',
      'x.json',
    );
    expect(report.applied).toBe(false);

    const merged = applyCompetitorImport(report, base);
    expect(merged.blockedChannelIds).toContain(UC_OK);
    expect(merged.blockedChannelIds).toContain(UC_OK_2); // preserved
    expect(merged.blockedPhraseRules.some((p) => p.phrase === 'slop')).toBe(true);
    expect(merged.blockedPhrases).toContain('preexisting'); // preserved

    const reverted = revertCompetitorImport(merged, base);
    expect(reverted).toEqual(base);
  });

  it('apply is idempotent — importing the same file twice does not duplicate rules', () => {
    const base = defaultRules();
    const report = previewCompetitorImport(
      JSON.stringify({ blockedChannels: [UC_OK], blockedKeywords: ['slop'] }),
      'blocktube',
      'x.json',
    );
    const once = applyCompetitorImport(report, base);
    const twice = applyCompetitorImport(report, once);
    expect(twice.blockedChannelIds.filter((id) => id === UC_OK)).toHaveLength(1);
    expect(twice.blockedPhraseRules.filter((p) => p.phrase === 'slop')).toHaveLength(1);
  });
});
