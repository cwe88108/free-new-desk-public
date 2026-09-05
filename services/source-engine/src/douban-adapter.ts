import type { CategoryResult,DetailResult,Episode,HomeResult,PlayResult,SearchResult,SourceAdapter,SourceConfig,SourceContext,VideoCard } from '@free-new-desk/contracts';
import { RequestBroker } from '@free-new-desk/source-sdk';

// Built-in Douban adapter: browse/search/detail with official trailer playback.
// Activated automatically when a T3_JAR source references a Spider class that is
// missing from its JAR and the source is Douban-flavoured.

type JsonRecord = Record<string, unknown>;
const COUNT = 24;
const REXXAR_KEY = '0ac44ae016490db2204ce0a042fa29f0';
interface DoubanCategory { id: string; name: string; type: string; tag: string; }
const CATEGORIES: DoubanCategory[] = [
  { id: 'movie', name: '电影', type: 'movie', tag: '热门' },
  { id: 'tv', name: '剧集', type: 'tv', tag: '热门' },
  { id: 'show', name: '综艺', type: 'tv', tag: '综艺' },
  { id: 'anime', name: '动漫', type: 'tv', tag: '动漫' }
];
function doubanHeaders(extra: Record<string, string> = {}): Record<string, string> { return { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36', Referer: 'https://m.douban.com/', Accept: 'application/json, text/plain, */*', ...extra }; }
function asRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function firstString(value: unknown, ...keys: string[]): string | undefined { const record = asRecord(value); for (const key of keys) { const item = record[key]; if (typeof item === 'string' && item) return item; } return undefined; }
function ratingText(value: unknown): string | undefined { if (typeof value === 'number') return String(value); if (typeof value === 'string' && value) return value; const inner = asRecord(value).value; return typeof inner === 'number' ? String(inner) : undefined; }
function coverUrl(value: unknown): string | undefined { if (typeof value === 'string') return value && value !== '' ? value : undefined; const record = asRecord(value); return firstString(record, 'large', 'cover_url', 'cover', 'img', 'medium', 'image', 'url'); }
function subjectId(value: unknown): string { const record = asRecord(value); if (typeof record.id === 'string' && record.id) return record.id; if (typeof record.id === 'number') return String(record.id); const uri = typeof record.uri === 'string' ? record.uri : typeof record.url === 'string' ? record.url : ''; const match = /subject\/(\d+)/.exec(uri); return match?.[1] ?? ''; }
function toCard(node: unknown): VideoCard | undefined {
  const record = asRecord(node); const target = asRecord(record.target ?? record.subject ?? record);
  const name = firstString(target, 'title', 'name') ?? firstString(record, 'title', 'name'); if (!name) return undefined;
  const id = subjectId(target) || subjectId(record); if (!id) return undefined;
  const poster = coverUrl(target.cover ?? record.cover ?? target.pic ?? record.pic ?? target.img ?? record.img ?? target.images ?? record.images);
  const rating = ratingText(target.rating ?? record.rating);
  const remark = firstString(target, 'sub_title', 'card_subtitle') ?? firstString(record, 'sub_title', 'card_subtitle');
  return { id, name, ...(poster ? { poster } : {}), ...(rating ? { rating } : {}), ...(remark ? { remark } : {}) };
}
function collectNodes(data: unknown, ...keys: string[]): unknown[] { if (Array.isArray(data)) return data; const record = asRecord(data); for (const key of keys) { const nodes = asArray(record[key]); if (nodes.length) return nodes; } return []; }
export class DoubanAdapter implements SourceAdapter {
  readonly #broker: RequestBroker; readonly #config: SourceConfig; readonly #stale = new Map<string, unknown>(); #context: SourceContext | undefined;
  constructor(config: SourceConfig, broker?: RequestBroker) { this.#config = config; this.#broker = broker ?? new RequestBroker(); }
  async init(ctx: SourceContext): Promise<void> { this.#context = ctx; }
  async #json(url: string): Promise<unknown> { try { const response = await this.#broker.request({ sourceId: this.#config.id, url, headers: doubanHeaders(), timeoutMs: 15_000, retries: 1 }); if (!response.ok) throw new Error(`豆瓣接口 HTTP ${response.status}`); const text = await response.text(); let parsed: unknown; try { parsed = JSON.parse(text) as unknown; } catch { throw new Error('豆瓣接口返回了无法解析的内容'); } this.#stale.set(url, parsed); return parsed; } catch (error) { if (this.#stale.has(url)) return this.#stale.get(url); throw error; } }
  async #jsonFallback(urls: string[]): Promise<unknown> { let last: unknown; for (const url of urls) { try { return await this.#json(url); } catch (error) { last = error; } } throw last instanceof Error ? last : new Error('豆瓣接口全部不可用'); }
  async #list(category: DoubanCategory, page: number): Promise<VideoCard[]> {
    const start = (page - 1) * COUNT;
    const kind = encodeURIComponent(JSON.stringify({ '类型': category.type === 'movie' ? '电影' : '剧集' }));
    const data = await this.#jsonFallback([
      `https://m.douban.com/rexxar/api/v2/subject/recommend?start=${start}&count=${COUNT}&selected_categories=${kind}&tags=${encodeURIComponent(category.tag)}&uncollect=false&apiKey=${REXXAR_KEY}`,
      `https://movie.douban.com/j/search_subjects?type=${category.type}&tag=${encodeURIComponent(category.tag)}&sort=recommend&page_limit=${COUNT}&page=${page}&page_start=${start}`
    ]);
    return collectNodes(data, 'items', 'subjects').map(toCard).filter((card): card is VideoCard => Boolean(card));
  }
  async getHome(): Promise<HomeResult> { const items = await this.#list(CATEGORIES[0] ?? CATEGORIES[0]!, 1); return { items, categories: CATEGORIES.map(({ id, name }) => ({ id, name })) }; }
  async getCategory(categoryId: string, page: number): Promise<CategoryResult> { const category = CATEGORIES.find(item => item.id === categoryId) ?? CATEGORIES[0]!; const items = await this.#list(category, page); return { page, hasMore: items.length >= COUNT, items }; }
  async getDetail(ids: string[]): Promise<DetailResult> {
    const id = ids[0] ?? ''; if (!id) throw new Error('豆瓣详情缺少条目 id');
    // 详情端点不接受该 apiKey（会返回 400 invalid_apikey），必须不带 key 请求
    const data = await this.#jsonFallback([
      `https://m.douban.com/rexxar/api/v2/movie/${id}`,
      `https://m.douban.com/rexxar/api/v2/tv/${id}`
    ]);
    const record = asRecord(data);
    const name = firstString(record, 'title', 'name') ?? '未知条目';
    const poster = coverUrl(record.pic ?? record.images ?? record.cover);
    const rating = ratingText(record.rating);
    const year = firstString(record, 'year');
    const area = Array.isArray(record.countries) ? (record.countries as unknown[]).filter((item): item is string => typeof item === 'string').join(' / ') : firstString(record, 'area');
    const genres = asArray(record.genres).filter((item): item is string => typeof item === 'string');
    const director = asArray(record.directors).map(item => asRecord(item).name ?? item).filter((item): item is string => typeof item === 'string').slice(0, 8);
    const actors = asArray(record.casts).map(item => asRecord(item).name ?? item).filter((item): item is string => typeof item === 'string').slice(0, 20);
    const description = firstString(record, 'intro', 'description') ?? firstString(asRecord(record.intro), 'plain');
    const episodes: Episode[] = [];
    [...asArray(record.trailers), ...asArray(record.clips)].forEach((node, index) => { const trailer = asRecord(node); const url = firstString(trailer, 'resource_url', 'url', 'video_url', 'mp4_url'); if (!url) return; const title = firstString(trailer, 'title', 'name') ?? `预告片 ${index + 1}`; episodes.push({ flag: '预告片', id: url, name: title }); });
    return { id, name, ...(poster ? { poster } : {}), ...(rating ? { rating } : {}), ...(year ? { year } : {}), ...(area ? { area } : {}), ...(genres.length ? { type: genres.join(' / ') } : {}), ...(director.length ? { director: director.join(' / ') } : {}), ...(actors.length ? { actors } : {}), ...(description ? { description } : {}), episodes };
  }
  async search(keyword: string, page = 1): Promise<SearchResult> {
    const data = await this.#jsonFallback([
      // subject_suggest 无需 apiKey，返回顶层数组（title / img / sub_title / id）
      `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(keyword)}`,
      `https://m.douban.com/rexxar/api/v2/search?q=${encodeURIComponent(keyword)}&start=${(page - 1) * 20}&count=20&sort=relevance&apiKey=${REXXAR_KEY}`
    ]);
    const items = collectNodes(data, 'items', 'subjects').map(toCard).filter((card): card is VideoCard => Boolean(card));
    return { page, items };
  }
  async getPlay(_flag: string, id: string): Promise<PlayResult> { if (!id) throw new Error('豆瓣预告片缺少播放地址'); if (!/^https?:\/\//i.test(id)) throw new Error('豆瓣预告片地址无效'); return { url: id, parse: false }; }
  async destroy(): Promise<void> { if (this.#context) this.#broker.clearCookies(this.#context.sourceId); this.#stale.clear(); this.#context = undefined; }
}
