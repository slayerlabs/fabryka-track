import re


def test_document_routes_share_loadable_frontend_assets(client):
    paths = ['/', '/overview', '/goals', '/status', '/agents', '/goals/250m-english-base-model',
             '/benchmark-results', '/leaderboard', '/runs', '/new', '/guide',
             '/account', '/login', '/register', '/benchmarks', '/checkpoints',
             '/run/7caf2e37-e453-4e31-8a5d-2e4425f606d2',
             '/compare/7caf2e37-e453-4e31-8a5d-2e4425f606d2?metric=val%2Floss']
    bundles = set()
    for path in paths:
        response = client.get(path)
        assert response.status_code == 200
        assert response.headers['cache-control'] == 'no-cache'
        scripts = re.findall(r'<script[^>]+src="([^"]+)"', response.text)
        assert any(url.startswith('/assets/') and 'plotly' not in url for url in scripts)
        bundles.update(scripts)
    for url in bundles:
        response = client.get(url)
        assert response.status_code == 200
        assert 'javascript' in response.headers['content-type']
    for path in ['/missing-page', '/run/not-an-id', '/api/missing', '/assets/missing.js',
                 '/assets/..%2Fsettings.py']:
        assert client.get(path).status_code == 404
