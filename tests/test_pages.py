def test_document_routes(client):
    for path, title in [('/leaderboard', 'Leaderboard'), ('/runs', 'My runs'),
                        ('/new', 'Training studio'), ('/guide', 'Learning guide'),
                        ('/account', 'Account'), ('/login', 'Sign in'),
                        ('/benchmarks', 'Benchmarks'),
                        ('/run/7caf2e37-e453-4e31-8a5d-2e4425f606d2', 'Run dashboard'),
                        ('/compare/7caf2e37-e453-4e31-8a5d-2e4425f606d2?metric=val%2Floss', 'Compare runs')]:
        response = client.get(path)
        assert response.status_code == 200
        assert f'<title>{title} · Fabryka Track</title>' in response.text
        assert response.headers['cache-control'] == 'no-cache'
    for path in ['/missing-page', '/run/not-an-id', '/api/missing']:
        assert client.get(path).status_code == 404
