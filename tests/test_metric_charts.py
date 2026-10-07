import base64

import pytest
from pydantic import ValidationError

from fabryka_track.metric_charts import ChartInput, build_figure


def sample(**updates):
    return {'series': [{'name': 'Training loss', 'color': '#b35236',
                        'x': [28501, 28502, 28600, 28700], 'y': [2.65, 2.76, 2.85, 2.69]}], **updates}


def test_resume_plot_fits_recorded_steps_and_has_no_connecting_lines():
    fig, ax = build_figure(ChartInput(**sample()))
    assert ax.get_xlim()[0] > 28000 and ax.get_xlim()[1] < 29000
    assert not ax.lines
    assert len(ax.collections) == 1
    assert ax.collections[0].get_offsets().tolist() == [[28501, 2.65], [28502, 2.76], [28600, 2.85], [28700, 2.69]]
    fig.clear()


def test_range_is_relative_to_recorded_data_and_zoom_bounds_are_preserved():
    fig, ax = build_figure(ChartInput(**sample(skip=.5)))
    assert ax.get_xlim()[0] > 28590
    fig.clear()
    fig, ax = build_figure(ChartInput(**sample(xlim=[28501, 28520], ylim=[2.5, 2.9])))
    assert ax.get_xlim() == (28501, 28520)
    assert ax.get_ylim() == (2.5, 2.9)
    fig.clear()


def test_single_measurement_and_constant_learning_rate_have_useful_limits():
    data = sample()
    data['series'][0].update(x=[28502], y=[.0015])
    fig, ax = build_figure(ChartInput(**data))
    assert ax.get_xlim()[0] < 28502 < ax.get_xlim()[1]
    assert 0 < ax.get_ylim()[0] < .0015 < ax.get_ylim()[1] < .002
    fig.clear()


@pytest.mark.parametrize('updates', [{'width': 100000}, {'series': [{'name': 'bad', 'color': '#b35236', 'x': [1], 'y': []}]},
                                     {'xlim': [2, 1]}, {'scale': 'log', 'ylim': [0, 1]}])
def test_render_inputs_are_bounded(updates):
    with pytest.raises(ValidationError):
        ChartInput(**sample(**updates))


def test_render_returns_matplotlib_png_and_coordinate_metadata_without_auth_or_storage(client):
    client.cookies.clear()
    response = client.post('/api/charts/render', json=sample(scale='log'))
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['renderer'] == 'matplotlib'
    assert base64.b64decode(result['image'].split(',', 1)[1]).startswith(b'\x89PNG\r\n\x1a\n')
    assert result['xlim'][0] > 28000 and all(v > 0 for v in result['ylim'])
    assert len(result['axes']) == 4
    assert client.post('/api/charts/render', json=sample(width=100000)).status_code == 422
