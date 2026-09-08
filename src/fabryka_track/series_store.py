"""Bounded series reads, separate from mutable metadata and blob storage.

SQL is the compatibility adapter for the current installation. A future
ClickHouse adapter must preserve run ownership, append semantics and cursors.
"""
from sqlalchemy import select

from .models import Metric


class SQLSeriesStore:
    def __init__(self,session):
        self.session=session

    def append(self,points):
        self.session.add_all(points)

    def read_page(self,run_id,path,after,limit):
        return list(self.session.scalars(select(Metric).where(
            Metric.run_id==run_id,Metric.key==path,Metric.id>after
        ).order_by(Metric.id).limit(limit+1)))
