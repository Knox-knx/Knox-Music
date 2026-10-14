// KNOX Music Vibe & Genre Classifier — intelligent related-song discovery.
//
// Solves:
//   1. Genre/Vibe consistency: Phonk plays next Phonk, Sufi/Bollywood plays
//      soulful/romantic Hindi, Lofi plays chill lofi, etc.
//   2. Anti-same-singer repetition: Prevents chaining 5-10 tracks by the exact
//      same artist back-to-back when a user plays a single song.
//   3. Variant/Duplicate rejection: Drops "(Remix)", "(Slowed + Reverb)",
//      "(Lofi Version)" or cover variants of the same title so the user gets
//      genuine fresh tracks.

import type { Song } from '../core/types';

export type MusicVibe =
  | 'phonk'
  | 'romantic_sad'
  | 'bollywood_romantic'
  | 'bollywood_sufi'
  | 'punjabi'
  | 'lofi'
  | 'edm'
  | 'hiphop'
  | 'rock_metal'
  | 'pop'
  | 'general';

export interface VibeInfo {
  vibe: MusicVibe;
  genreLabel: string;
  relatedQueries: string[];
  isSameVibe: (candidate: { title: string; artist?: string; genre?: string }) => boolean;
}

const PHONK_ARTISTS = new Set([
  'interworld', 'kordhell', 'dvrst', 'hensonn', 'pharmacist', 'playaphonk',
  'lxst cxntury', 'moondeity', 'ghostface playa', 'shadxwbxrn', 'sxmpra',
  'kaito shoma', 'mc orsen', 'twisted', 'scarlxrd', 'plamenev', 'g3ox_em',
  'slowboys', 'zxkcurse', 'yatashigang', 'cursed', 'kute', 'mup',
  'ogryzek', 'eternxlkz', 'atlxs', 'scythermane', 'nxgth', 'histed',
  'txmy', 'vyral', 'dj fku', 'mc gw', 'mc menor da vg', 'ariis', 'dxrk',
  'nueki', 'tolchonov', 'phonkha', 'zecki', 'skorde', 'dybbukk', 'haarper',
  'freddie dredd', 'repsaj', 'kslv', 'kslv noh', 'onis', 'xxanteria', 'isq',
]);

const SUFI_BOLLYWOOD_ARTISTS = new Set([
  'rahat fateh ali khan', 'nusrat fateh ali khan', 'kailash kher', 'arijit singh',
  'atif aslam', 'mohit chauhan', 'javed ali', 'kk', 'sonu nigam', 'shreya ghoshal',
  'shankar mahadevan', 'shankar-ehsaan-loy', 'a.r. rahman', 'ar rahman', 'pritam',
  'mithoon', 'shafqat amanat ali', 'lucky ali', 'b praak', 'jubin nautiyal',
  'darshan raval', 'vishal mishra', 'papon', 'mustafa zahid', 'tochi raina',
  'kavita seth', 'amit trivedi', 'harshdeep kaur', 'ali zafar', 'sanam',
  'akhil sachdeva', 'stebin ben', 'armaan malik', 'amaal mallik', 'sachet tandon',
  'parampara tandon', 'rochak kohli', 'tanishk bagchi', 'yasser desai', 'ankit tiwari',
  'meet bros', 'shilpa rao', 'sunidhi chauhan', 'alka yagnik', 'kumar sanu',
  'udit narayan', 'abhijeet', 'jasleen royal', 'prateek kuhad', 'anuv jain',
  'asim azhar', 'ali sethi', 'qurat-ul-ain balouch',
]);

const PUNJABI_ARTISTS = new Set([
  'sidhu moose wala', 'diljit dosanjh', 'karan aujla', 'ap dhillon', 'shubh',
  'gurinder gill', 'amrit maan', 'jassie gill', 'ammy virk', 'harrdy sandhu',
  'gippy grewal', 'jordan sandhu', 'babbu maan', 'mankirt aulakh', 'kulwinder billa',
]);

const LOFI_ARTISTS = new Set([
  'lofi girl', 'chilledcow', 'potsu', 'kupla', 'jinsang', 'idealism',
  'saib', 'elijah who', 'kudasai', 'sarcastic sounds', 'powfu',
]);

const EDM_ARTISTS = new Set([
  'alan walker', 'avicii', 'martin garrix', 'david guetta', 'kygo',
  'marshmello', 'the chainsmokers', 'tiesto', 'calvin harris', 'alesso',
  'skrillex', 'illenium', 'hardwell', 'zedd', 'dj snake', 'afrojack',
]);

const HIPHOP_ARTISTS = new Set([
  'drake', 'eminem', 'travis scott', 'metro boomin', '21 savage', 'kendrick lamar',
  'j. cole', 'kanye west', 'future', 'lil baby', 'post malone', 'juice wrld',
  'xxxtentacion', 'cardi b', 'nicky jam', 'asap rocky', 'central cee',
]);

const ROCK_ARTISTS = new Set([
  'linkin park', 'metallica', 'nirvana', 'queen', 'ac/dc', 'green day',
  'slipknot', 'bring me the horizon', 'red hot chili peppers', 'guns n roses',
  'foo fighters', 'imagine dragons', 'coldplay', 'arctic monkeys',
]);

/** Normalize artist name to strip features, parentheticals, and punctuation. */
export function normalizeArtistName(raw: string | undefined): string {
  if (!raw) return '';
  let s = raw.toLowerCase().trim();
  // Strip featuring artists: "A feat. B", "A ft. B", "A featuring B", "A & B", "A x B"
  s = s.replace(/\s+(feat\.?|ft\.?|featuring|with)\s+.*$/i, '');
  s = s.replace(/[,&/x+].*$/, '');
  s = s.replace(/[^\w\s]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Clean song title to extract primary base title without noise. */
export function cleanSongTitle(raw: string | undefined): string {
  if (!raw) return '';
  let s = raw.toLowerCase().trim();
  // Remove (Official Video), [Audio], [4K], etc.
  s = s.replace(/\((official|video|audio|lyrics|music|hd|4k|remastered|visualizer).*?\)/gi, '');
  s = s.replace(/\[(official|video|audio|lyrics|music|hd|4k|remastered|visualizer).*?\]/gi, '');
  // Remove trailing variant tags
  s = s.replace(/\((remix|slowed|reverb|lofi|speed up|cover|acoustic|live|8d).*?\)/gi, '');
  s = s.replace(/\[(remix|slowed|reverb|lofi|speed up|cover|acoustic|live|8d).*?\]/gi, '');
  s = s.replace(/\b(official video|official audio|music video|full song)\b/gi, '');
  s = s.replace(/[^\w\s]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Detect if a YouTube video is non-music junk (comedy, roast, vlog, podcast, news, status, etc.). */
export function isNonMusicVideo(title: string | undefined, artistOrChannel?: string): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  const c = (artistOrChannel || '').toLowerCase();
  const combined = `${t} ${c}`;

  const nonMusicPatterns = [
    /\b(comedy|chutkula|chutkule|hasya|hasgulle|roast|prank|funny\s*video|natak|dehati\s*comedy|bhojpuri\s*comedy|khortha\s*comedy)\b/i,
    /\b(bail\s*bazar|kalkatiya|mela|bazaar|market|vlog|daily\s*vlog|vlogger|family\s*vlog)\b/i,
    /\b(poetry|shayari|mushaira|kavita|kavi\s*sammelan|ghazal\s*recitation|speech|bhashan|pravachan|satsang|katha)\b/i,
    /\b(news|samachar|khabar|breaking\s*news|crime\s*patrol|savdhaan|episode|ep\s*\d+|ep\.\s*\d+|web\s*series)\b/i,
    /\b(podcast|interview|unboxing|review|reaction\s*video|reacts?\s*to|gameplay|walkthrough|bgmi|pubg|free\s*fire|minecraft)\b/i,
    /\b(whatsapp\s*status|30\s*sec\s*status|fullscreen\s*status|shorts\s*status|short\s*status|status\s*video)\b/i,
  ];

  for (const pat of nonMusicPatterns) {
    if (pat.test(combined)) return true;
  }
  return false;
}

/** Detect if a candidate track is an unwanted low-quality variant (slowed, reverb, lofi, lyrics, etc.). */
export function isUnwantedVariant(title: string | undefined): boolean {
  if (!title) return false;
  const variantPattern =
    /\b(slowed\s*\+?\s*reverb|slowed|reverb|lofi\s*version|lofi\s*mix|lo-fi\s*remix|lofi\s*flip|speed\s*up|speedup|sped\s*up|nightcore|8d\s*audio|8d|bass\s*boosted|bassboosted|ringtone|whatsapp\s*status|lyrics\s*video|lyric\s*video|with\s*lyrics|full\s*lyrics|karaoke|instrumental|clean\s*audio|status\s*video|short\s*version)\b/i;
  return variantPattern.test(title);
}

/** Detect if a video is a multi-song compilation, jukebox, or mega mix rather than an individual song. */
export function isCompilationOrJukebox(title: string | undefined): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  const jukeboxPatterns = [
    /\b(jukebox|audio\s*jukebox|video\s*jukebox)\b/i,
    /\b(top\s*\d+\s*(romantic|bollywood|hindi|punjabi|songs|hits))\b/i,
    /\b(best\s*of\s*\w+\s*(songs|jukebox|hits))\b/i,
    /\b(non\s*stop|mega\s*mix|all\s*songs\s*jukebox|full\s*album)\b/i,
    /\b(\d+\s*romantic\s*songs|\d+\s*love\s*songs|\d+\s*sad\s*songs)\b/i,
  ];
  return jukeboxPatterns.some((pat) => pat.test(t));
}

/**
 * Extract clean primary song title without artist/movie/label noise,
 * for accurate YouTube Mix ("Mix - <Song>") discovery.
 */
export function extractPrimarySongTitle(raw: string | undefined): string {
  if (!raw) return '';
  let s = raw.trim();

  // Strip leading artist prefix like "Arijit Singh : " or "T-Series :"
  s = s.replace(/^[A-Za-z0-9\s.,'&]+:\s*/, '');

  // Split by common YouTube title dividers: |, —, –, //
  const pipeParts = s.split(/[|—–//]/);
  let mainPart = (pipeParts[0] || '').trim();

  // If mainPart has " - ", extract the song name side
  if (mainPart.includes(' - ')) {
    const dashParts = mainPart.split(' - ').map((p) => p.trim());
    if (dashParts[0] && dashParts[0].split(/\s+/).length <= 6) {
      mainPart = dashParts[0];
    } else if (dashParts[1] && dashParts[1].split(/\s+/).length <= 6) {
      mainPart = dashParts[1];
    }
  }

  // Remove parentheses/brackets: (Official Video), (From "..."), [4K], etc.
  mainPart = mainPart.replace(/\(.*?\)/g, ' ').replace(/\[.*?\]/g, ' ');

  // Remove common YouTube clutter words
  mainPart = mainPart.replace(
    /\b(official video|official audio|music video|full song|video song|lyric video|visualizer|audio song|full video|hd 4k|4k|1080p|remastered)\b/gi,
    ' ',
  );

  // Strip non-alphanumeric except spaces
  mainPart = mainPart.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

  return mainPart || cleanSongTitle(raw);
}

/** Check if candidate is essentially the same song (duplicate or remix/cover variant). */
export function isSameSongOrVariant(
  candidate: { title: string; artist?: string },
  target: { title: string; artist?: string },
): boolean {
  const cleanA = cleanSongTitle(candidate.title);
  const cleanB = cleanSongTitle(target.title);
  if (!cleanA || !cleanB) return false;
  if (cleanA === cleanB) return true;

  const primA = extractPrimarySongTitle(candidate.title).toLowerCase();
  const primB = extractPrimarySongTitle(target.title).toLowerCase();
  if (primA && primB && primA === primB) return true;

  // If one title starts with the other and is long enough
  if (cleanA.length > 5 && cleanB.length > 5) {
    if (cleanA.startsWith(cleanB) || cleanB.startsWith(cleanA)) return true;
  }
  return false;
}

/** Detect music vibe from track metadata or search query. */
export function detectMusicVibe(
  song: { title: string; artist?: string; album?: string; genre?: string },
  queryHint?: string,
): VibeInfo {
  const primaryTitle = extractPrimarySongTitle(song.title);
  const cleanTitle = cleanSongTitle(song.title);
  const searchName = primaryTitle || cleanTitle;
  const normArtist = normalizeArtistName(song.artist);
  const combined = `${song.title || ''} ${song.artist || ''} ${song.genre || ''} ${song.album || ''} ${queryHint || ''}`.toLowerCase();

  // 1. Phonk / Funk
  const phonkKeywords = [
    'phonk', 'funk', 'drift', 'montagem', 'funk mandelao', 'brazilian phonk',
    'brazilian funk', 'aura phonk', 'ultrafunk', 'krushfunk', 'automotivo',
    'ritmada', 'passo bem solto', 'brodyaga', 'slide phonk', 'gym phonk',
  ];
  const isPhonk =
    PHONK_ARTISTS.has(normArtist) ||
    phonkKeywords.some((k) => combined.includes(k));
  if (isPhonk) {
    return {
      vibe: 'phonk',
      genreLabel: 'Funk & Drift Phonk',
      relatedQueries: [
        `Mix - ${searchName} funk`,
        `${searchName} phonk funk mix`,
        'brazilian funk drift phonk mix',
        'best funk phonk songs mix',
        'brazilian funk playlist',
      ],
      isSameVibe: (c) => {
        const ct = `${c.title} ${c.artist || ''} ${c.genre || ''}`.toLowerCase();
        return (
          phonkKeywords.some((k) => ct.includes(k)) ||
          ct.includes('funk') ||
          ct.includes('aura') ||
          PHONK_ARTISTS.has(normalizeArtistName(c.artist))
        );
      },
    };
  }

  // 2. Romantic Sad & Heartbreak Hits
  const romanticSadKeywords = [
    'tum jo aaye sad', 'soch', 'samjhawan', 'channa mereya', 'bekhayali', 'hamari adhuri kahani',
    'thodi jagah', 'phir bhi tumko', 'judaai', 'judai', 'tujhe bhula diya',
    'agar tum saath ho', 'ae dil hai mushkil', 'kaash aisa hota', 'humnava mere',
    'lo safar', 'sunn raha hai', 'tera chehra', 'mann mera', 'dard', 'sad romantic',
    'romantic sad', 'sad songs', 'heartbreak', 'broken heart', 'tadap', 'bewafa',
    'bhula dena', 'rona', 'khairiyat', 'kabira sad', 'duaa', 'marjaawaan', 'filhall',
    'pachtaoge', 'bada pachtaoge', 'baarish ki jaaye', 'lut gaye', 'roye roye',
    'sau dard', 'tanhaai', 'hasi ban gaye', 'judaiyaan', 'mile ho tum', 'alvida',
    'humdard', 'tere bina jeena', 'toota tara', 'ya rabba', 'jag ghoomeya', 'o bedardeya',
    'dard dilo ke', 'tu bichdan', 'main dhoondne ko zamaane mein',
  ];
  const isRomanticSad = romanticSadKeywords.some((k) => combined.includes(k));
  if (isRomanticSad) {
    return {
      vibe: 'romantic_sad',
      genreLabel: 'Romantic Sad & Heartbreak Hits',
      relatedQueries: [
        `Mix - ${searchName}`,
        `${searchName} sad romantic mix`,
        'romantic sad hindi songs playlist',
        'best sad romantic bollywood songs mix',
        'heartbroken sad hindi songs mix',
        'arijit singh sad romantic songs playlist',
        'dard bhare romantic gaane mix',
      ],
      isSameVibe: (c) => {
        const ct = `${c.title} ${c.artist || ''} ${c.genre || ''}`.toLowerCase();
        return (
          romanticSadKeywords.some((k) => ct.includes(k)) ||
          SUFI_BOLLYWOOD_ARTISTS.has(normalizeArtistName(c.artist)) ||
          ct.includes('sad') || ct.includes('heartbreak') || ct.includes('dard')
        );
      },
    };
  }

  // 3. Romantic Bollywood & Love Melodies
  const romanticKeywords = [
    'tum jo aaye', 'pee loon', 'ye tune kya kiya', 'saibo', 'zaalima', 'tere sang yaara',
    'saanware', 'kesariya', 'raabta', 'tum hi ho', 'pehle bhi main', 'tere hawaale',
    'apna bana le', 'deva deva', 'tum se hi', 'pehli nazar', 'humsafar', 'channa ve',
    'tera ban jaunga', 'dil diyan gallan', 'hawaayein', 'shayad', 'ishq', 'romantic',
    'love songs', 'mohabbat', 'pyaar', 'dil ko karaar aaya', 'manike', 'subhanallah',
    'bol do na zara', 'dheere dheere', 'jeene laga hoon', 'tu jaane na', 'tera hone laga hoon',
    'o saathi', 'tere bina', 'pal pal dil ke paas', 'ishq wala love', 'rula ke gaya ishq',
    'mast magan', 'khuda jaane', 'jashn e bahara', 'tum mile', 'matargashti', 'sukoon mila',
    'jeena jeena', 'main rang sharbaton ka', 'gerua', 'janam janam', 'tujh me rab dikhta hai',
    'sun saathiya', 'ban ja rani', 'nazm nazm', 'tere mere', 'duniyaa', 've maahi',
    'tera zikr', 'kaun tujhe', 'naina', 'enha soni',
  ];
  const isRomantic = romanticKeywords.some((k) => combined.includes(k));
  if (isRomantic) {
    return {
      vibe: 'bollywood_romantic',
      genreLabel: 'Romantic Bollywood Melodies',
      relatedQueries: [
        `Mix - ${searchName}`,
        `${searchName} mix`,
        'best romantic hindi songs playlist',
        'bollywood love songs playlist',
        'top hindi romantic songs mix',
        'arijit singh romantic hits mix',
        'latest hindi romantic songs playlist',
      ],
      isSameVibe: (c) => {
        const ct = `${c.title} ${c.artist || ''} ${c.genre || ''}`.toLowerCase();
        return (
          romanticKeywords.some((k) => ct.includes(k)) ||
          SUFI_BOLLYWOOD_ARTISTS.has(normalizeArtistName(c.artist)) ||
          ct.includes('romantic') || ct.includes('love') || ct.includes('pyaar')
        );
      },
    };
  }

  // 4. Bollywood / Sufi / Soulful Hindi
  const sufiKeywords = [
    'sajjda', 'o re piya', 'teri ore', 'kun faya kun', 'mitwa', 'afreen',
    'khwaja', 'sufi', 'qawwali', 'ghazal', 'bollywood', 'hindi', 'urdu',
    'coke studio', 'kalank', 'mast nazron', 'kabira', 'chaap tilak',
    'tajdar e haram', 'rashke qamar', 'nit khair manga', 'dam dam mast qalandar',
    'shikayat', 'rangrez', 'andaaz', 'sunn le zara',
  ];
  const isSufiBollywood =
    SUFI_BOLLYWOOD_ARTISTS.has(normArtist) ||
    sufiKeywords.some((k) => combined.includes(k));
  if (isSufiBollywood) {
    return {
      vibe: 'bollywood_sufi',
      genreLabel: 'Soulful & Sufi Bollywood',
      relatedQueries: [
        'soulful sufi bollywood songs mix',
        `Mix - ${searchName}`,
        `${searchName} sufi mix`,
        'best sufi songs hindi playlist',
        'coke studio best sufi songs',
        'rahat fateh ali khan sufi hits',
      ],
      isSameVibe: (c) => {
        const ct = `${c.title} ${c.artist || ''} ${c.genre || ''}`.toLowerCase();
        return (
          SUFI_BOLLYWOOD_ARTISTS.has(normalizeArtistName(c.artist)) ||
          sufiKeywords.some((k) => ct.includes(k)) ||
          ct.includes('bollywood') ||
          ct.includes('hindi')
        );
      },
    };
  }

  // 3. Punjabi
  const isPunjabi =
    PUNJABI_ARTISTS.has(normArtist) ||
    combined.includes('punjabi') ||
    combined.includes('bhangra') ||
    combined.includes('sidhu') ||
    combined.includes('moosewala') ||
    combined.includes('jatt');
  if (isPunjabi) {
    return {
      vibe: 'punjabi',
      genreLabel: 'Punjabi Hits & Vibes',
      relatedQueries: [
        `Mix - ${searchName}`,
        `${searchName} punjabi mix`,
        'top punjabi hit songs playlist',
        'punjabi vibe songs mix',
      ],
      isSameVibe: (c) => {
        const ct = `${c.title} ${c.artist || ''} ${c.genre || ''}`.toLowerCase();
        return PUNJABI_ARTISTS.has(normalizeArtistName(c.artist)) || ct.includes('punjabi');
      },
    };
  }

  // 4. Lo-Fi
  const isLofi =
    LOFI_ARTISTS.has(normArtist) ||
    combined.includes('lofi') ||
    combined.includes('lo-fi') ||
    combined.includes('chillhop') ||
    combined.includes('chill beats') ||
    combined.includes('study beats');
  if (isLofi) {
    return {
      vibe: 'lofi',
      genreLabel: 'Lo-Fi Chill & Study Beats',
      relatedQueries: [
        `Mix - ${searchName}`,
        `${searchName} lofi mix`,
        'lofi hip hop chill beats mix',
        'relaxing lofi songs playlist',
      ],
      isSameVibe: (c) => {
        const ct = `${c.title} ${c.artist || ''} ${c.genre || ''}`.toLowerCase();
        return ct.includes('lofi') || ct.includes('lo-fi') || ct.includes('chillhop') || LOFI_ARTISTS.has(normalizeArtistName(c.artist));
      },
    };
  }

  // 5. EDM / Electronic
  const isEdm =
    EDM_ARTISTS.has(normArtist) ||
    combined.includes('edm') ||
    combined.includes('electronic') ||
    combined.includes('house') ||
    combined.includes('techno') ||
    combined.includes('dubstep');
  if (isEdm) {
    return {
      vibe: 'edm',
      genreLabel: 'Electronic & Dance Hits',
      relatedQueries: [
        `Mix - ${searchName}`,
        `${searchName} edm mix`,
        'melodic edm hits mix',
        'progressive house playlist',
      ],
      isSameVibe: (c) => {
        const ct = `${c.title} ${c.artist || ''} ${c.genre || ''}`.toLowerCase();
        return ct.includes('edm') || ct.includes('electronic') || ct.includes('house') || EDM_ARTISTS.has(normalizeArtistName(c.artist));
      },
    };
  }

  // 6. Hip Hop / Rap
  const isHipHop =
    HIPHOP_ARTISTS.has(normArtist) ||
    combined.includes('hip hop') ||
    combined.includes('rap') ||
    combined.includes('trap') ||
    combined.includes('drill');
  if (isHipHop) {
    return {
      vibe: 'hiphop',
      genreLabel: 'Hip Hop & Melodic Rap',
      relatedQueries: [
        `Mix - ${searchName}`,
        `${searchName} rap mix`,
        'best hip hop songs mix',
        'melodic rap hits playlist',
      ],
      isSameVibe: (c) => {
        const ct = `${c.title} ${c.artist || ''} ${c.genre || ''}`.toLowerCase();
        return ct.includes('rap') || ct.includes('hip hop') || ct.includes('trap') || HIPHOP_ARTISTS.has(normalizeArtistName(c.artist));
      },
    };
  }

  // 7. Rock / Metal
  const isRock =
    ROCK_ARTISTS.has(normArtist) ||
    combined.includes('rock') ||
    combined.includes('metal') ||
    combined.includes('metalcore') ||
    combined.includes('punk');
  if (isRock) {
    return {
      vibe: 'rock_metal',
      genreLabel: 'Rock & Alternative',
      relatedQueries: [
        `Mix - ${searchName}`,
        `${searchName} rock mix`,
        'best rock songs playlist',
        'alternative rock mix',
      ],
      isSameVibe: (c) => {
        const ct = `${c.title} ${c.artist || ''} ${c.genre || ''}`.toLowerCase();
        return ct.includes('rock') || ct.includes('metal') || ROCK_ARTISTS.has(normalizeArtistName(c.artist));
      },
    };
  }

  // Default / Generic: Smart YouTube Mix query
  return {
    vibe: 'general',
    genreLabel: normArtist ? `${normArtist} & Similar` : 'Related Mix',
    relatedQueries: [
      `Mix - ${searchName}`,
      `${searchName} mix`,
      `songs like ${searchName} ${normArtist}`.trim(),
      `${normArtist} radio mix`.trim(),
    ].filter(Boolean),
    isSameVibe: () => true,
  };
}

/**
 * Detect music vibe directly from a search query string.
 */
export function detectMoodFromQuery(query: string): MusicVibe {
  const q = (query || '').toLowerCase();
  if (q.includes('phonk') || q.includes('funk') || q.includes('drift') || q.includes('montagem')) return 'phonk';
  const romanticSadKeywords = [
    'tum jo aaye sad', 'soch', 'samjhawan', 'channa mereya', 'bekhayali', 'hamari adhuri kahani',
    'thodi jagah', 'phir bhi tumko', 'judaai', 'judai', 'tujhe bhula diya',
    'agar tum saath ho', 'ae dil hai mushkil', 'kaash aisa hota', 'humnava mere',
    'lo safar', 'sunn raha hai', 'tera chehra', 'mann mera', 'dard', 'sad romantic',
    'romantic sad', 'sad songs', 'heartbreak', 'broken heart', 'tadap', 'bewafa',
    'bhula dena', 'rona', 'khairiyat', 'kabira sad', 'duaa', 'marjaawaan', 'filhall',
    'pachtaoge', 'bada pachtaoge', 'baarish ki jaaye', 'lut gaye', 'roye roye',
    'sau dard', 'tanhaai', 'hasi ban gaye', 'judaiyaan', 'mile ho tum', 'alvida',
    'humdard', 'tere bina jeena', 'toota tara', 'ya rabba', 'jag ghoomeya', 'o bedardeya',
    'dard dilo ke', 'tu bichdan', 'main dhoondne ko zamaane mein',
  ];
  if (romanticSadKeywords.some((k) => q.includes(k))) return 'romantic_sad';
  const romanticKeywords = [
    'tum jo aaye', 'pee loon', 'ye tune kya kiya', 'saibo', 'zaalima', 'tere sang yaara',
    'saanware', 'kesariya', 'raabta', 'tum hi ho', 'pehle bhi main', 'tere hawaale',
    'apna bana le', 'deva deva', 'tum se hi', 'pehli nazar', 'humsafar', 'channa ve',
    'tera ban jaunga', 'dil diyan gallan', 'hawaayein', 'shayad', 'ishq', 'romantic',
    'love songs', 'mohabbat', 'pyaar', 'dil ko karaar aaya', 'manike', 'subhanallah',
    'bol do na zara', 'dheere dheere', 'jeene laga hoon', 'tu jaane na', 'tera hone laga hoon',
    'o saathi', 'tere bina', 'pal pal dil ke paas', 'ishq wala love', 'rula ke gaya ishq',
    'mast magan', 'khuda jaane', 'jashn e bahara', 'tum mile', 'matargashti', 'sukoon mila',
    'jeena jeena', 'main rang sharbaton ka', 'gerua', 'janam janam', 'tujh me rab dikhta hai',
    'sun saathiya', 'ban ja rani', 'nazm nazm', 'tere mere', 'duniyaa', 've maahi',
  ];
  if (romanticKeywords.some((k) => q.includes(k))) return 'bollywood_romantic';
  if (q.includes('sufi') || q.includes('sajjda') || q.includes('qawwali')) return 'bollywood_sufi';
  if (q.includes('punjabi') || q.includes('bhangra')) return 'punjabi';
  if (q.includes('lofi') || q.includes('lo-fi') || q.includes('chillhop')) return 'lofi';
  if (q.includes('edm') || q.includes('electronic') || q.includes('house')) return 'edm';
  if (q.includes('rap') || q.includes('hip hop') || q.includes('trap')) return 'hiphop';
  if (q.includes('rock') || q.includes('metal')) return 'rock_metal';
  return 'general';
}

/**
 * Filter & order candidates to enforce artist diversity and assemble up to 50+ tracks.
 *
 * Rules:
 *   1. NEVER put the same artist as currentSong in the very next position.
 *   2. NEVER put two consecutive songs by the same artist.
 *   3. Multi-pass distribution to fill targetCount (up to 52 songs) with rich artist variety.
 *   4. Reject duplicates or remix/variant of the played song or already-chosen songs.
 */
export function enforceArtistDiversity(
  candidates: Song[],
  currentSong: Song,
  countOrMaxPerArtist = 52,
): Song[] {
  const isMaxPerArtistMode = countOrMaxPerArtist <= 3;
  const targetCount = isMaxPerArtistMode ? 52 : countOrMaxPerArtist;
  const maxAllowedPerArtist = isMaxPerArtistMode ? Math.max(1, countOrMaxPerArtist) : 3;

  const currentArtist = normalizeArtistName(currentSong.artist);
  const chosen: Song[] = [];
  const artistCounts = new Map<string, number>();

  const canAddArtist = (art: string, isNext: boolean, maxPerArtist: number): boolean => {
    if (!art) return true;
    if (isNext && currentArtist && art === currentArtist) {
      // Don't put the same singer immediately after the current song!
      return false;
    }
    const lastChosenArtist = chosen.length > 0 ? normalizeArtistName(chosen[chosen.length - 1].artist) : '';
    if (lastChosenArtist && art === lastChosenArtist) {
      // No consecutive same artist!
      return false;
    }
    const count = artistCounts.get(art) ?? 0;
    if (count >= maxPerArtist) {
      return false;
    }
    return true;
  };

  // Pass 1: 1 song per artist (maximum diversity)
  for (const cand of candidates) {
    if (chosen.length >= targetCount) break;
    if (!cand || !cand.id || !cand.title) continue;
    if (cand.id === currentSong.id) continue;
    if (isSameSongOrVariant(cand, currentSong)) continue;
    if (chosen.some((c) => c.id === cand.id || isSameSongOrVariant(cand, c))) continue;

    const candArtist = normalizeArtistName(cand.artist);
    const isFirstUpcoming = chosen.length === 0;

    if (canAddArtist(candArtist, isFirstUpcoming, 1)) {
      chosen.push(cand);
      if (candArtist) {
        artistCounts.set(candArtist, (artistCounts.get(candArtist) ?? 0) + 1);
      }
    }
  }

  // Pass 2: Up to 2 songs per artist (never consecutive, never immediately next to currentSong)
  if (maxAllowedPerArtist >= 2 && chosen.length < targetCount) {
    for (const cand of candidates) {
      if (chosen.length >= targetCount) break;
      if (!cand || !cand.id || !cand.title) continue;
      if (cand.id === currentSong.id) continue;
      if (isSameSongOrVariant(cand, currentSong)) continue;
      if (chosen.some((c) => c.id === cand.id || isSameSongOrVariant(cand, c))) continue;

      const candArtist = normalizeArtistName(cand.artist);
      const isFirstUpcoming = chosen.length === 0;

      if (canAddArtist(candArtist, isFirstUpcoming, 2)) {
        chosen.push(cand);
        if (candArtist) {
          artistCounts.set(candArtist, (artistCounts.get(candArtist) ?? 0) + 1);
        }
      }
    }
  }

  // Pass 3: Up to 3 songs per artist if needed to reach targetCount
  if (maxAllowedPerArtist >= 3 && chosen.length < targetCount) {
    for (const cand of candidates) {
      if (chosen.length >= targetCount) break;
      if (!cand || !cand.id || !cand.title) continue;
      if (cand.id === currentSong.id) continue;
      if (isSameSongOrVariant(cand, currentSong)) continue;
      if (chosen.some((c) => c.id === cand.id || isSameSongOrVariant(cand, c))) continue;

      const candArtist = normalizeArtistName(cand.artist);
      const isFirstUpcoming = chosen.length === 0;

      if (canAddArtist(candArtist, isFirstUpcoming, 3)) {
        chosen.push(cand);
        if (candArtist) {
          artistCounts.set(candArtist, (artistCounts.get(candArtist) ?? 0) + 1);
        }
      }
    }
  }

  // Pass 4: Fill remaining without consecutive repeats
  if (!isMaxPerArtistMode && chosen.length < targetCount) {
    for (const cand of candidates) {
      if (chosen.length >= targetCount) break;
      if (!cand || !cand.id || !cand.title) continue;
      if (cand.id === currentSong.id) continue;
      if (isSameSongOrVariant(cand, currentSong)) continue;
      if (chosen.some((c) => c.id === cand.id || isSameSongOrVariant(cand, c))) continue;

      const candArtist = normalizeArtistName(cand.artist);
      const lastChosenArtist = chosen.length > 0 ? normalizeArtistName(chosen[chosen.length - 1].artist) : '';
      if (lastChosenArtist && candArtist === lastChosenArtist) continue;
      if (chosen.length === 0 && currentArtist && candArtist === currentArtist) continue;

      chosen.push(cand);
    }
  }

  return chosen;
}

/**
 * Smartly process raw YouTube search results:
 * 1. Filters non-music videos (comedy, roast, poetry, vlogs, status, etc.).
 * 2. Filters spam duplicate variants (slowed, reverb, lofi, lyrics).
 * 3. Expands search results with YouTube's real-time generated Mix playlist (RDAMVM / RD)
 *    plus related vibe queries into a full 40-50+ related playlist.
 * 4. Enforces artist diversity so the user never gets back-to-back same singer repeats.
 */
export async function processSmartYouTubeResults(
  rawResults: Song[],
  query: string,
  signal?: AbortSignal,
): Promise<Song[]> {
  if (!rawResults || rawResults.length === 0) return [];
  if (signal?.aborted) return [];

  const cleanQuery = (query || '').trim().toLowerCase();

  // 1. Filter junk and non-music videos
  const validMusicResults = rawResults.filter((s) => {
    if (!s || !s.title) return false;
    if (isNonMusicVideo(s.title, s.artist)) return false;
    // Discard multi-song compilations/jukeboxes unless user explicitly queried for them
    if (isCompilationOrJukebox(s.title) && !cleanQuery.includes('jukebox') && !cleanQuery.includes('album') && !cleanQuery.includes('mashup')) {
      return false;
    }
    // Discard suspiciously short clips (< 40s whatsapp status) unless query specifically asks for shorts/status
    if (s.durationMs > 0 && s.durationMs < 40000 && !cleanQuery.includes('status') && !cleanQuery.includes('short')) {
      return false;
    }
    // Allow extended devotional / long tracks up to 2 hours (7,200,000 ms), e.g., 44-min "Barsana Bali Radhey"
    if (s.durationMs > 7200000 && !cleanQuery.includes('movie') && !cleanQuery.includes('album') && !cleanQuery.includes('jukebox')) {
      return false;
    }
    return true;
  });

  // 2. Separate legitimate primary songs from low-quality variants
  const primaryCandidates: Song[] = [];
  const variantCandidates: Song[] = [];

  for (const s of validMusicResults) {
    if (isUnwantedVariant(s.title)) {
      variantCandidates.push(s);
    } else {
      primaryCandidates.push(s);
    }
  }

  // Use clean primary candidates first; fallback to variants only if no clean candidate exists
  const initialPool = primaryCandidates.length > 0 ? primaryCandidates : variantCandidates;
  if (initialPool.length === 0) return [];

  // Deduplicate exact titles within initial results (keep max 1 reprise/acoustic)
  const seenTitles = new Map<string, number>();
  const deduplicatedInitial: Song[] = [];

  for (const s of initialPool) {
    const base = cleanSongTitle(s.title);
    const count = seenTitles.get(base) ?? 0;
    if (count === 0) {
      seenTitles.set(base, 1);
      deduplicatedInitial.push(s);
    } else if (count === 1 && (s.title.toLowerCase().includes('reprise') || s.title.toLowerCase().includes('acoustic'))) {
      seenTitles.set(base, 2);
      deduplicatedInitial.push(s);
    }
  }

  const primarySong = deduplicatedInitial[0];
  if (!primarySong) return deduplicatedInitial;

  // Detect vibe of the query and primary song
  const vibe = detectMusicVibe(primarySong, query);

  // If we already have a large diverse set (40+ songs) or abort requested, return diverse assembly
  if (deduplicatedInitial.length >= 40 || signal?.aborted) {
    return enforceArtistDiversity(deduplicatedInitial, primarySong, 52);
  }

  // 3. Enrich with real-time YouTube Mix playlist first, then fallback to related vibe queries
  const relatedTracks: Song[] = [];
  const excludeIds = new Set<string>(deduplicatedInitial.map((s) => s.id));

  try {
    const { getProviderManager } = await import('../providers/ProviderManager');
    const provider = getProviderManager().get('youtube') as unknown as {
      capabilities: { supportsSearch?: boolean };
      searchSongs: (q: string, s?: AbortSignal) => Promise<Song[]>;
      getMixPlaylist?: (videoId: string, s?: AbortSignal) => Promise<Song[]>;
    } | undefined;

    if (provider && !signal?.aborted) {
      const videoId = primarySong.providerTrackId || primarySong.id.replace(/^youtube:/, '');
      if (typeof provider.getMixPlaylist === 'function' && videoId) {
        try {
          const mixItems = await provider.getMixPlaylist(videoId, signal);
          if (Array.isArray(mixItems)) {
            for (const ms of mixItems) {
              if (signal?.aborted || (deduplicatedInitial.length + relatedTracks.length) >= 55) break;
              if (!ms || !ms.id || excludeIds.has(ms.id)) continue;
              if (isNonMusicVideo(ms.title, ms.artist)) continue;
              if (isCompilationOrJukebox(ms.title)) continue;
              if (ms.durationMs > 900000) continue;
              if (isSameSongOrVariant(ms, primarySong)) continue;
              excludeIds.add(ms.id);
              relatedTracks.push(ms);
            }
          }
        } catch {
          // fallback to search queries below
        }
      }

      if (provider.capabilities?.supportsSearch && !signal?.aborted && (deduplicatedInitial.length + relatedTracks.length) < 35) {
        const queriesToTry = vibe.relatedQueries.slice(0, 3);
        for (const rq of queriesToTry) {
          if (signal?.aborted || (deduplicatedInitial.length + relatedTracks.length) >= 55) break;
          try {
            const fetched = await provider.searchSongs(rq, signal);
            if (!Array.isArray(fetched)) continue;
            for (const fs of fetched) {
              if (signal?.aborted || (deduplicatedInitial.length + relatedTracks.length) >= 55) break;
              if (!fs || !fs.id || excludeIds.has(fs.id)) continue;
              if (isNonMusicVideo(fs.title, fs.artist)) continue;
              if (isUnwantedVariant(fs.title)) continue;
              if (isCompilationOrJukebox(fs.title)) continue;
              if (fs.durationMs > 900000) continue;
              if (isSameSongOrVariant(fs, primarySong)) continue;
              if (vibe.vibe !== 'general' && !vibe.isSameVibe(fs)) continue;
              excludeIds.add(fs.id);
              relatedTracks.push(fs);
            }
          } catch {
            // ignore single query search error
          }
        }
      }
    }
  } catch {
    // enrichment is best-effort
  }

  // Real-time Mix tracks come right after the primary song so the search list reflects the real-time playlist
  const combinedPool = [primarySong, ...relatedTracks, ...deduplicatedInitial.slice(1)];
  const diversePlaylist = enforceArtistDiversity(combinedPool, primarySong, 52);

  // Ensure the primary searched song is strictly first
  const finalResult = [
    primarySong,
    ...diversePlaylist.filter((s) => s.id !== primarySong.id),
  ];

  return finalResult;
}

