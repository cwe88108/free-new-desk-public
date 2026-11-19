"""Original, network-free CatVod-shaped fixture. No third-party source code."""
from base.spider import Spider as BaseSpider

class Spider(BaseSpider):
    def init(self, extend=''):
        self.label = extend
        self.setCache('fixture', {'value': 'cached'})
        assert self.getCache('fixture')['value'] == 'cached'
        assert self.base64Decode(self.base64Encode('中文')) == '中文'
        assert self.md5('fixture') == '4cf9d4f0069fc18fb3fcc0a50dceb852'
        assert self.isVideoFormat('https://media.example/a.m3u8?token=fixture')
    def homeContent(self, filter):
        return self.json2str({'class': [{'type_id': 'film', 'type_name': 'Films'}]})
    def homeVideoContent(self):
        return {'list': [{'vod_id': 'fixture', 'vod_name': self.label}]}
    def categoryContent(self, tid, pg, filter, extend):
        return {'page': int(pg), 'pagecount': 3, 'list': [{'vod_id': tid, 'vod_name': extend.get('label', 'Category')}]}
    def detailContent(self, ids):
        return self.json2str({'list': [{'vod_id': ids[0], 'vod_name': 'Fixture', 'vod_play_from': 'fixture', 'vod_play_url': 'Episode$https://media.example/fixture.mp4'}]})
    def searchContent(self, key, quick):
        return {'list': [{'vod_id': 'fixture', 'vod_name': key}]}
    def playerContent(self, flag, id, vipFlags):
        return self.json2str({'parse': 0, 'url': id, 'header': {'User-Agent': 'authored-fixture'}})
