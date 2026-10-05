import { describe,it,expect } from 'vitest';
import { parseHeadlines } from '../src/pulse-news.js';
describe('Pulse headlines',()=>{
 const source={name:'Publisher',host:'example.com'},now=Date.parse('2026-10-05T12:00:00Z');
 const feed=(link:string,date='Mon, 05 Oct 2026 10:00:00 GMT')=>`<rss><channel><item><title>Headline</title><link>${link}</link><pubDate>${date}</pubDate></item></channel></rss>`;
 it('keeps source links with stable dedupe ids',()=>{const items=parseHeadlines(feed('https://example.com/news'),source,now);expect(items).toHaveLength(1);expect(items[0]?.id).toBe(parseHeadlines(feed('https://example.com/news'),source,now)[0]?.id);});
 it('rejects unsafe links, other domains and stale or invalid dates',()=>{for(const link of ['javascript:alert(1)','https://evil.com/news','https://example.com.evil.com/news'])expect(parseHeadlines(feed(link),source,now)).toEqual([]);for(const date of ['bad','Mon, 01 Jan 2024 10:00:00 GMT'])expect(parseHeadlines(feed('https://example.com/news',date),source,now)).toEqual([]);});
 it('handles empty feeds',()=>expect(parseHeadlines('<rss/>',source,now)).toEqual([]));
 it('accepts explicitly allowed publisher domains without weakening host checks',()=>{
  const bbc={name:'BBC Business',host:'bbc.co.uk',additionalHosts:['bbc.com']};
  expect(parseHeadlines(feed('https://www.bbc.com/news/story'),bbc,now)).toHaveLength(1);
  expect(parseHeadlines(feed('https://bbc.com.evil.test/news'),bbc,now)).toEqual([]);
 });


});
