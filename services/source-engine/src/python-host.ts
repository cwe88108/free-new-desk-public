import {PYTHON_BASE_SPIDER, PYTHON_PROFILE} from './python-profile.js';

// Bundled protocol host, not downloaded code. -I/-S limit accidental imports, NOT OS privileges.
export const PYTHON_HOST = String.raw`
import sys, json, contextlib, types, inspect
base = types.ModuleType("base")
base.__path__ = []
base_spider = types.ModuleType("base.spider")
exec(${JSON.stringify(PYTHON_BASE_SPIDER)}, base_spider.__dict__)
base.spider = base_spider
sys.modules["base"] = base
sys.modules["base.spider"] = base_spider
# Small, independently authored requests-compatible facade over the bounded urllib helpers.
# This is not the third-party requests package and intentionally omits streaming/adapters.
requests_module = types.ModuleType("requests")
class _RequestsSession:
    def __init__(self):
        self.headers = {}
        self.cookies = {}
    def request(self, method, url, **kwargs):
        headers = dict(self.headers)
        headers.update(kwargs.pop("headers", {}) or {})
        cookies = kwargs.pop("cookies", self.cookies)
        spider = base_spider.Spider()
        verb = str(method).upper()
        if verb == "GET":
            return spider.fetch(url, headers=headers, cookies=cookies, **kwargs)
        if verb == "POST":
            return spider.post(url, headers=headers, cookies=cookies, **kwargs)
        raise NotImplementedError("only GET and POST are supported")
    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)
    def post(self, url, **kwargs):
        return self.request("POST", url, **kwargs)
    def close(self):
        pass
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, traceback):
        self.close()
requests_module.Session = _RequestsSession
requests_module.request = lambda method, url, **kwargs: _RequestsSession().request(method, url, **kwargs)
requests_module.get = lambda url, **kwargs: _RequestsSession().get(url, **kwargs)
requests_module.post = lambda url, **kwargs: _RequestsSession().post(url, **kwargs)
requests_module.__version__ = "fnd-requests-compat-1"
requests_module.Response = base_spider.Response
exceptions_module = types.ModuleType("requests.exceptions")
exceptions_module.RequestException = Exception
exceptions_module.HTTPError = RuntimeError
exceptions_module.Timeout = TimeoutError
exceptions_module.ConnectionError = OSError
requests_module.exceptions = exceptions_module
sys.modules["requests"] = requests_module
sys.modules["requests.exceptions"] = exceptions_module
if sys.version_info < (3, 10):
    sys.exit(2)
wire = sys.stdout
spider = None
methods = {"homeContent", "homeVideoContent", "categoryContent", "detailContent", "searchContent", "playerContent"}
for line in sys.stdin:
    request_id = None
    try:
        request = json.loads(line)
        request_id = request["id"]
        with contextlib.redirect_stdout(sys.stderr):
            if request["method"] == "init":
                scope = {"__name__": "approved_spider", "__file__": "approved_spider.py"}
                exec(compile(request["args"][0], "approved_spider.py", "exec"), scope)
                spider = scope["Spider"]()
                required = methods - {"homeVideoContent"}
                if not all(callable(getattr(spider, name, None)) and getattr(getattr(spider, name), "__func__", None) is not getattr(base_spider.Spider, name, None) for name in required):
                    raise AttributeError("profile")
                initializer = getattr(spider, "init", None)
                if initializer is not None:
                    initializer(request["args"][1])
                dependencies = getattr(spider, "getDependence", lambda: [])()
                if dependencies:
                    raise ImportError("additional executable dependencies are unsupported")
                result = {"profile": "${PYTHON_PROFILE}"}
            elif request["method"] in methods and spider is not None:
                handler = getattr(spider, request["method"], None)
                args = request["args"]
                if request["method"] == "searchContent":
                    # Bind before invocation. Never catch a source TypeError and retry it.
                    signature = inspect.signature(handler)
                    kwargs = {}
                    try:
                        signature.bind(*args)
                    except TypeError:
                        try:
                            signature.bind(*args[:2], pg=args[2])
                            kwargs = {"pg": args[2]}
                            args = args[:2]
                        except TypeError:
                            signature.bind(*args[:2])
                            args = args[:2]
                    result = handler(*args, **kwargs)
                else:
                    result = handler(*args) if handler is not None else {"list": []}
            else:
                raise AttributeError("method")
        if isinstance(result, str):
            result = json.loads(result)
        if not isinstance(result, (dict, list)):
            raise TypeError("result")
        payload = json.dumps({"id": request_id, "ok": True, "result": result}, ensure_ascii=True, allow_nan=False)
        if len(payload) > 4 * 1024 * 1024:
            raise OverflowError("output")
    except BaseException as error:
        # Never return source exception text: it can contain credentials or signed URLs.
        payload = json.dumps({"id": request_id, "ok": False, "error": type(error).__name__})
    wire.write(payload + "\n")
    wire.flush()
`;
