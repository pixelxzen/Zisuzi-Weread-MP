#!/usr/bin/env python3
"""Obsidian 插件的定时采集是否真的跑起来了 —— 只读轮询探针。

用途：改完插件凭据（cookie / 登录态）后，插件要等满一个 interval 才会跑首轮，
单次检查必然误报「没生效」。本脚本记下首轮看到的 lastRun.at 作为基线，
之后轮询直到 at 前进（或超时），从而区分「还没到点」与「真的坏了」。

用法：
    python3 plugin_cookie_check.py                          # 单次探测（只打一行现状）
    python3 plugin_cookie_check.py --wait 3000 --interval 180
    python3 plugin_cookie_check.py --data-json <path> --log <path>

退出码：0 = lastRun 已前进且 error 为空；3 = 超时仍是基线/报错。
任一插件（只要 data.json 里有 settings + state.lastRun.at/error）都能用，不限于微信读书。
"""
import argparse
import json
import os
import time

def _default_data():
    """插件 data.json：优先 WEREAD_PLUGIN_DATA / --data，其次从常见库位置猜"""
    v = os.environ.get('WEREAD_PLUGIN_DATA')
    if v:
        return os.path.expanduser(v)
    cands = [
        os.path.expanduser('~/Obsidian/.obsidian/plugins/zisuzi-weread-mp/data.json'),
        os.path.expanduser('~/Documents/Obsidian/.obsidian/plugins/zisuzi-weread-mp/data.json'),
    ]
    for c in cands:
        if os.path.exists(c):
            return c
    return cands[0]


DEFAULT_DATA = _default_data()
DEFAULT_LOG = os.path.expanduser('~/.weread-monitor/logs/plugin-cookie-fix-check.log')


def probe(path):
    d = json.load(open(path, encoding='utf-8'))
    s = d.get('settings', {}) or {}
    lr = (d.get('state', {}) or {}).get('lastRun', {}) or {}
    at = lr.get('at', 0)
    fields = len([p for p in (s.get('cookie') or '').split(';')
                  if '=' in p and p.split('=', 1)[1]])
    return {
        'at': at,
        'error': lr.get('error'),
        'found': lr.get('found'),
        'written': lr.get('written'),
        'fields': fields,
        'mtime': os.path.getmtime(path),
    }


def line_of(p):
    at = p['at'] / 1000 if p['at'] else 0
    return '{} | lastRun {} | found {} | written {} | error {} | cookie_fields {} | data_mtime {}'.format(
        time.strftime('%F %T'),
        time.strftime('%H:%M:%S', time.localtime(at)) if at else '-',
        p['found'], p['written'], p['error'], p['fields'],
        time.strftime('%H:%M:%S', time.localtime(p['mtime'])),
    )


def emit(log, text):
    if log:
        os.makedirs(os.path.dirname(log), exist_ok=True)
        with open(log, 'a', encoding='utf-8') as f:
            f.write(text + '\n')
    print(text, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data-json', default=DEFAULT_DATA)
    ap.add_argument('--log', default=DEFAULT_LOG)
    ap.add_argument('--wait', type=int, default=0, help='最长等待秒数（0 = 只探一次）')
    ap.add_argument('--interval', type=int, default=180)
    a = ap.parse_args()

    base = probe(a.data_json)
    emit(a.log, '[baseline] ' + line_of(base))
    if a.wait <= 0:
        return 0

    deadline = time.time() + a.wait
    while time.time() < deadline:
        time.sleep(min(a.interval, max(1, int(deadline - time.time()))))
        cur = probe(a.data_json)
        moved = cur['at'] != base['at']
        ok = moved and not cur['error']
        emit(a.log, line_of(cur) + ' | ' + ('OK' if ok else ('MOVED_BUT_ERROR' if moved else 'PENDING')))
        if ok:
            print('VERDICT OK', flush=True)
            return 0
        if moved and cur['error']:
            print('VERDICT ERROR: {}'.format(cur['error']), flush=True)
            return 3

    print('VERDICT TIMEOUT_PENDING — 可能 interval 未到，或被观测的定时器根本没启', flush=True)
    return 3


if __name__ == '__main__':
    raise SystemExit(main())
