# Kioku 用的 PostgreSQL：官方 pgvector 镜像加上 zhparser 中文分词。
# 源码版本与校验值写死；升级时同时改版本号和 sha256 / commit。
FROM pgvector/pgvector:0.8.7-pg16

ARG SCWS_VERSION=1.2.3
ARG SCWS_SHA256=60d50ac3dc42cff3c0b16cb1cfee47d8cb8c8baa142a58bc62854477b81f1af5
ARG ZHPARSER_COMMIT=2d1bf73e46ebb82393610afbeb3af271f1056488
# GitHub 生成的源码归档偶尔会重新打包导致哈希变化；校验失败时先确认该 commit 的源码没变，再更新这里
ARG ZHPARSER_SHA256=fd8ad02143462a02906b0fc204800f6ce30f3c929538d2cd180c27c286726f35

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends build-essential postgresql-server-dev-16 ca-certificates curl bzip2; \
    curl -fsSL -o /tmp/scws.tar.bz2 "https://www.xunsearch.com/scws/down/scws-${SCWS_VERSION}.tar.bz2"; \
    echo "${SCWS_SHA256}  /tmp/scws.tar.bz2" | sha256sum -c -; \
    tar -xjf /tmp/scws.tar.bz2 -C /tmp; \
    cd "/tmp/scws-${SCWS_VERSION}"; ./configure; make -j"$(nproc)"; make install; ldconfig; \
    curl -fsSL -o /tmp/zhparser.tar.gz "https://github.com/amutu/zhparser/archive/${ZHPARSER_COMMIT}.tar.gz"; \
    echo "${ZHPARSER_SHA256}  /tmp/zhparser.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/zhparser.tar.gz -C /tmp; \
    cd "/tmp/zhparser-${ZHPARSER_COMMIT}"; make -j"$(nproc)" SCWS_HOME=/usr/local; make install SCWS_HOME=/usr/local; \
    apt-get purge -y --auto-remove build-essential postgresql-server-dev-16 curl bzip2; \
    rm -rf /var/lib/apt/lists/* /tmp/scws* /tmp/zhparser*

COPY init/ /docker-entrypoint-initdb.d/
