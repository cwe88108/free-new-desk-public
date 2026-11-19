/** Independently authored compatibility subset. No upstream CatVod implementation copied. */
export const PYTHON_PROFILE = 'python-catvod-stdlib-v3';
export const PYTHON_BASE_SPIDER = String.raw`
import base64, hashlib, json, re, time
from urllib import request, parse, error

class Response:
    def __init__(self, response):
        self.status_code = response.code
        self.headers = dict(response.headers)
        self.url = response.geturl()
        self.encoding = response.headers.get_content_charset() or 'utf-8'
        self.content = response.read(4 * 1024 * 1024 + 1)
        if len(self.content) > 4 * 1024 * 1024:
            raise ValueError('response limit')
    @property
    def ok(self):
        return self.status_code < 400
    @property
    def text(self):
        return self.content.decode(self.encoding, errors='replace')
    def json(self):
        return json.loads(self.text)
    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError('HTTP status failure')

class Spider:
    def __init__(self):
        self._cache = {}
    def init(self, extend=''):
        pass
    def getName(self):
        return self.__class__.__name__
    def getDependence(self):
        return []
    def destroy(self):
        pass
    def homeContent(self, filter):
        raise NotImplementedError('homeContent')
    def homeVideoContent(self):
        return {'list': []}
    def categoryContent(self, tid, pg, filter, extend):
        raise NotImplementedError('categoryContent')
    def detailContent(self, ids):
        raise NotImplementedError('detailContent')
    def searchContent(self, key, quick, pg='1'):
        raise NotImplementedError('searchContent')
    def playerContent(self, flag, id, vipFlags):
        raise NotImplementedError('playerContent')
    def isVideoFormat(self, url):
        return bool(re.search(r'\.(?:m3u8|mp4|mkv|flv|avi|mov|ts)(?:[?#]|$)', url, re.I))
    def manualVideoCheck(self):
        return False
    def getProxyUrl(self, local=True):
        raise NotImplementedError('proxy callbacks are not supported')
    def localProxy(self, params):
        raise NotImplementedError('proxy callbacks are not supported')
    def log(self, message):
        print(message)
    def json2str(self, obj):
        return json.dumps(obj, ensure_ascii=False)
    def str2json(self, text):
        return json.loads(text)
    def base64Encode(self, text):
        return base64.b64encode(text.encode('utf-8')).decode('ascii')
    def base64Decode(self, text):
        return base64.b64decode(text).decode('utf-8')
    def md5(self, text):
        return hashlib.md5(text.encode('utf-8')).hexdigest()
    def getCache(self, key):
        value, expires = getattr(self, '_cache', {}).get(key, (None, 0))
        if expires and expires <= time.monotonic():
            self.delCache(key)
            return None
        return value
    def setCache(self, key, value):
        if not hasattr(self, '_cache'):
            self._cache = {}
        # CatVod cache payloads often carry an absolute Unix expires timestamp.
        expires = value.get('expires', 0) if isinstance(value, dict) else 0
        self._cache[key] = (value, time.monotonic() + max(0, float(expires) - time.time()) if expires else 0)
    def delCache(self, key):
        getattr(self, '_cache', {}).pop(key, None)
    def fetch(self, url, params=None, cookies=None, headers=None, timeout=10, verify=True, stream=False, allow_redirects=True):
        return self._request(url, None, params, cookies, headers, timeout, verify, stream, allow_redirects)
    def post(self, url, data=None, headers=None, cookies=None, timeout=10, verify=True, json=None, allow_redirects=True, params=None):
        if json is not None:
            if data is not None:
                raise ValueError('data and json are mutually exclusive')
            data = self.json2str(json).encode('utf-8')
            headers = {'Content-Type': 'application/json', **(headers or {})}
        elif isinstance(data, dict):
            data = parse.urlencode(data, doseq=True).encode('utf-8')
        elif isinstance(data, str):
            data = data.encode('utf-8')
        return self._request(url, data if data is not None else b'', params, cookies, headers, timeout, verify, False, allow_redirects)
    def _request(self, url, data, params, cookies, headers, timeout, verify, stream, allow_redirects):
        if not verify or stream:
            raise NotImplementedError('TLS bypass and streaming are not supported')
        if parse.urlsplit(url).scheme not in ('http', 'https'):
            raise ValueError('HTTP(S) required')
        if params:
            parts = parse.urlsplit(url)
            query = '&'.join(filter(None, [parts.query, parse.urlencode(params, doseq=True)]))
            url = parse.urlunsplit(parts._replace(query=query))
        headers = dict(headers or {})
        if cookies:
            headers['Cookie'] = '; '.join(str(k) + '=' + str(v) for k, v in cookies.items()) if isinstance(cookies, dict) else str(cookies)
        class Redirect(request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, response_headers, newurl):
                if not allow_redirects:
                    return None
                if parse.urlsplit(newurl).scheme not in ('http', 'https'):
                    raise ValueError('HTTP(S) redirect required')
                redirected = super().redirect_request(req, fp, code, msg, response_headers, newurl)
                old, new = parse.urlsplit(req.full_url), parse.urlsplit(newurl)
                if redirected is not None and (old.scheme, old.hostname, old.port) != (new.scheme, new.hostname, new.port):
                    redirected.remove_header('Authorization')
                    redirected.remove_header('Cookie')
                return redirected
        # No proxy/environment or persistent cookie/session inheritance.
        opener = request.build_opener(request.ProxyHandler({}), Redirect())
        try:
            response = opener.open(request.Request(url, data=data, headers=headers), timeout=min(max(float(timeout), 0.1), 15))
        except error.HTTPError as failure:
            response = failure
        with response:
            return Response(response)
`;
