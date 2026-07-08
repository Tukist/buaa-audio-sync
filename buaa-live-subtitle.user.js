// ==UserScript==
// @name         智学北航 语音识别字幕
// @namespace    https://github.com/Tukist/buaa-subtitle
// @version      1.0
// @description  将智学北航课堂的语音识别内容作为字幕显示在视频上
// @author       Tukist
// @match        https://classroom.msa.buaa.edu.cn/livingroom*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ============ 配置 ============
    const CONFIG = {
        subtitleStyle: {
            fontSize: '18px',
            fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
            color: '#ffffff',
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            padding: '8px 20px',
            borderRadius: '6px',
            textAlign: 'center',
            maxWidth: '90%',
            lineHeight: '1.6',
            textShadow: '1px 1px 2px rgba(0,0,0,0.8)',
        },
        pollInterval: 200,      // DOM 检测轮询间隔 (ms)
        maxWaitTime: 30000,     // 最大等待时间 (ms)
    };

    let video = null;
    let transList = null;
    let subtitleEl = null;
    let subtitleData = [];      // [{timeSec, text}]
    let lastIndex = -1;         // 上次显示的字幕索引，避免重复更新

    // ============ 辅助函数 ============

    /** 将 "HH:MM:SS" 转为秒数 */
    function timeToSeconds(timeStr) {
        const parts = timeStr.trim().split(':');
        if (parts.length !== 3) return 0;
        return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
    }

    /** 从 .trans-list_wrap 解析字幕数据 */
    function parseSubtitles() {
        if (!transList) return [];
        const items = [];
        const children = transList.children;
        let lastTimeSec = 0;
        for (let i = 0; i < children.length; i++) {
            const el = children[i];
            if (el.classList.contains('item-time')) {
                lastTimeSec = timeToSeconds(el.textContent);
            } else if (el.classList.contains('trans-item')) {
                const text = el.textContent.trim();
                if (text) {
                    items.push({ timeSec: lastTimeSec, text: text });
                }
            }
        }
        return items;
    }

    /** 创建字幕 DOM */
    function createSubtitleOverlay() {
        const el = document.createElement('div');
        el.id = 'buaa-live-subtitle';
        Object.assign(el.style, {
            position: 'absolute',
            bottom: '50px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: '9999',
            pointerEvents: 'none',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            transition: 'opacity 0.2s',
            ...CONFIG.subtitleStyle,
        });
        return el;
    }

    /** 把字幕 overlay 定位到视频容器内 */
    function mountSubtitle() {
        if (!video || !subtitleEl) return;
        const container = video.parentElement;
        if (!container) return;

        // 确保容器是 relative/absolute 定位
        const cs = getComputedStyle(container);
        if (cs.position === 'static') {
            container.style.position = 'relative';
        }

        // 确保视频容器 overflow 可见
        if (cs.overflow === 'hidden') {
            container.style.overflow = 'visible';
        }

        if (subtitleEl.parentElement !== container) {
            container.appendChild(subtitleEl);
        }
    }

    /** 根据视频当前时间查找对应字幕 */
    function findSubtitle(currentTime) {
        const data = subtitleData;
        if (data.length === 0) return null;

        // 二分查找：找到 timeSec <= currentTime 的最大索引
        let lo = 0, hi = data.length - 1, best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (data[mid].timeSec <= currentTime) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        if (best === -1) return null;

        // 合并当前时间点附近连续的字幕（同一秒内的多条合并）
        const currentTimeSec = data[best].timeSec;
        let merged = data[best].text;
        for (let i = best + 1; i < data.length && data[i].timeSec === currentTimeSec; i++) {
            merged += data[i].text;
        }
        return merged;
    }

    /** 更新字幕显示 */
    function updateSubtitle() {
        if (!video || !subtitleEl) return;

        const currentTime = video.currentTime;
        if (isNaN(currentTime)) return;

        const text = findSubtitle(currentTime);

        if (text) {
            // 判断是否需要更新（避免同一时间戳的重复渲染）
            const idx = subtitleData.findIndex(
                d => d.timeSec <= currentTime
            );
            // 简单判断: 文本变了才更新
            if (subtitleEl.textContent !== text) {
                subtitleEl.textContent = text;
                subtitleEl.style.opacity = '1';
            }
        } else {
            subtitleEl.style.opacity = '0';
        }
    }

    /** 监听 trans-list_wrap 的新增节点 */
    function observeTransList() {
        if (!transList) return;
        const observer = new MutationObserver(() => {
            subtitleData = parseSubtitles();
        });
        observer.observe(transList, { childList: true, subtree: false });
    }

    // ============ 主初始化 ============

    function init() {
        video = document.querySelector('.cmc-base.cmc-video video');
        transList = document.querySelector('.trans-list_wrap');

        if (!video || !transList) return false;

        // 解析现有字幕
        subtitleData = parseSubtitles();
        console.log(`[BuaaSubtitle] 已解析 ${subtitleData.length} 条字幕`);

        // 创建字幕 overlay
        subtitleEl = createSubtitleOverlay();
        mountSubtitle();

        // 监听视频时间更新
        video.addEventListener('timeupdate', updateSubtitle);

        // 视频尺寸变化时重新挂载
        video.addEventListener('resize', mountSubtitle);
        video.addEventListener('loadedmetadata', mountSubtitle);

        // 监听新字幕
        observeTransList();

        console.log('[BuaaSubtitle] ✅ 字幕系统已启动');
        return true;
    }

    // 轮询等待 DOM 就绪
    const startTime = Date.now();
    const pollTimer = setInterval(() => {
        if (init()) {
            clearInterval(pollTimer);
        } else if (Date.now() - startTime > CONFIG.maxWaitTime) {
            clearInterval(pollTimer);
            console.warn('[BuaaSubtitle] ⚠️ 超时：未检测到视频或语音识别元素');
        }
    }, CONFIG.pollInterval);

})();
