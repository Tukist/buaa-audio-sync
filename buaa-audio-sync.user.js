// ==UserScript==
// @name         智学北航 PPT音源同步
// @namespace    https://github.com/Tukist
// @version      6.1.0
// @description  切换PPT流保持教师音频 — 克隆模式，暂停/音量完美同步
// @author       Tukist
// @match        https://classroom.msa.buaa.edu.cn/livingroom*
// @grant        none
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const DEBUG = true;
    const SCAN_INTERVAL = 2000;

    let teacherVideo = null;
    let cloneVideo = null;
    let cloneAudioCtx = null;
    let cloneSource = null;
    let savedTeacherSrc = null;
    let syncEnabled = true;
    let panelEl = null;
    let syncInterval = null;
    let isOnPPT = false;
    let srcWatcher = null;        // 保存 observer 引用以便断开

    function log(...args) {
        if (DEBUG) console.log('[🎵]', ...args);
    }

    // ===== 识别教师流 =====
    function isTeacherStream(video) {
        if (!video) return false;
        if (video.hasAttribute('data-buaa-clone')) return false;
        const src = (video.src || video.currentSrc || '').toLowerCase();
        if (/(?:screen|ppt|courseware|share|capture|desktop|board|ai3)/i.test(src)) return false;
        if (/teacher|teache/i.test(src)) return true;
        if (video.audioTracks && video.audioTracks.length > 0) return true;
        if (typeof video.mozHasAudio !== 'undefined' && video.mozHasAudio) return true;
        if (src && src.length > 10 && !/(?:ppt\d{4}\/v)/i.test(src)) return true;
        return false;
    }

    function isPPTSrc(src) {
        return /(?:screen|ppt|courseware|share|capture|desktop|board|ai3|ppt\d{4}\/v)/i.test(src || '');
    }

    // ===== 创建克隆视频 =====
    function createCloneVideo(originalVideo) {
        teardownClone();
        savedTeacherSrc = originalVideo.src || originalVideo.currentSrc;
        if (!savedTeacherSrc) { log('❌ 无教师 src'); return; }

        log('🔧 创建克隆, src:', savedTeacherSrc.substring(0, 70));

        cloneVideo = document.createElement('video');
        cloneVideo.src = savedTeacherSrc;
        cloneVideo.muted = false;
        cloneVideo.volume = originalVideo.volume || 1.0;
        cloneVideo.crossOrigin = 'anonymous';
        cloneVideo.setAttribute('playsinline', '');
        cloneVideo.style.cssText =
            'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
        cloneVideo.setAttribute('data-buaa-clone', 'true');

        let synced = false;
        const doSync = () => {
            if (!synced && originalVideo.currentTime > 0 && cloneVideo.readyState >= 2) {
                cloneVideo.currentTime = originalVideo.currentTime;
                synced = true;
                log('⏱ 克隆同步到:', originalVideo.currentTime.toFixed(1));
            }
        };
        cloneVideo.addEventListener('loadedmetadata', doSync);
        cloneVideo.addEventListener('canplay', doSync);
        cloneVideo.addEventListener('seeked', () => {
            if (cloneVideo.paused && !isOnPPT && teacherVideo && !teacherVideo.paused) {
                cloneVideo.play().catch(() => {});
            }
        });

        // AudioContext
        try {
            cloneAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            cloneSource = cloneAudioCtx.createMediaElementSource(cloneVideo);
            cloneSource.connect(cloneAudioCtx.destination);
            if (cloneAudioCtx.state === 'suspended') cloneAudioCtx.resume().catch(() => {});
            log('✅ 克隆 AudioContext state=', cloneAudioCtx.state);
        } catch (e) {
            log('❌ AudioContext 失败:', e.message);
        }

        document.body.appendChild(cloneVideo);
        cloneVideo.play().catch(e => log('⚠ 克隆 play 失败:', e.message));
        log('✅ 克隆已启动');
    }

    function teardownClone() {
        if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
        if (srcWatcher) { try { srcWatcher.disconnect(); } catch (e) {} srcWatcher = null; }
        if (cloneSource) { try { cloneSource.disconnect(); } catch (e) {} cloneSource = null; }
        if (cloneAudioCtx) {
            try { if (cloneAudioCtx.state !== 'closed') cloneAudioCtx.close().catch(() => {}); }
            catch (e) {}
            cloneAudioCtx = null;
        }
        if (cloneVideo) {
            try { cloneVideo.pause(); cloneVideo.src = ''; cloneVideo.remove(); }
            catch (e) {}
            cloneVideo = null;
        }
    }

    // ===== 时间+状态同步 =====
    function startTimeSync() {
        if (syncInterval) clearInterval(syncInterval);
        syncInterval = setInterval(() => {
            if (!cloneVideo) return;

            // 始终同步：音量、静音状态（不管是不是 PPT 视图）
            // 找一个活跃的 video 来读取状态
            const activeVideo = teacherVideo || document.querySelector('video:not([data-buaa-clone])');
            if (activeVideo) {
                if (cloneVideo.volume !== activeVideo.volume && activeVideo.volume > 0.01) {
                    cloneVideo.volume = activeVideo.volume;
                }
                if (cloneVideo.muted !== activeVideo.muted) {
                    cloneVideo.muted = activeVideo.muted;
                }
            }

            // PPT 视图：只同步暂停/播放（用户可控制）
            if (isOnPPT && activeVideo) {
                if (activeVideo.paused && !cloneVideo.paused) {
                    cloneVideo.pause();
                } else if (!activeVideo.paused && cloneVideo.paused) {
                    cloneVideo.play().catch(() => {});
                }
                return; // PPT 视图不同步时间
            }

            // 教师视图：完整同步
            if (!teacherVideo || !document.contains(teacherVideo)) return;
            if (!teacherVideo.paused && teacherVideo.currentTime > 0) {
                const diff = Math.abs(cloneVideo.currentTime - teacherVideo.currentTime);
                if (diff > 0.5 && teacherVideo.readyState >= 2) {
                    cloneVideo.currentTime = teacherVideo.currentTime;
                }
            }
            // 暂停/播放同步
            if (teacherVideo.paused && !cloneVideo.paused) {
                cloneVideo.pause();
            } else if (!teacherVideo.paused && cloneVideo.paused) {
                cloneVideo.play().catch(() => {});
            }
        }, 300);
    }

    // ===== 监控原始视频 src 变化 =====
    function startSrcWatch(video) {
        if (srcWatcher) srcWatcher.disconnect();

        srcWatcher = new MutationObserver((mutations) => {
            for (const mut of mutations) {
                if (mut.type === 'attributes' &&
                    (mut.attributeName === 'src' || mut.attributeName === 'currentSrc')) {
                    const curSrc = video.src || video.currentSrc;
                    if (isPPTSrc(curSrc) && !isOnPPT) {
                        log('📺 → PPT 视图');
                        isOnPPT = true;
                        if (cloneVideo && cloneVideo.paused) cloneVideo.play().catch(() => {});
                        // 同步当前进度
                        if (cloneVideo && video.currentTime > 0) {
                            cloneVideo.currentTime = video.currentTime;
                        }
                    } else if (!isPPTSrc(curSrc) && isOnPPT) {
                        log('📺 → 教师视图');
                        isOnPPT = false;
                        // 恢复同步
                        if (cloneVideo && teacherVideo && teacherVideo.currentTime > 0) {
                            cloneVideo.currentTime = teacherVideo.currentTime;
                            if (cloneVideo.paused) cloneVideo.play().catch(() => {});
                        }
                    }
                }
            }
            updatePanel();
        });

        srcWatcher.observe(video, {
            attributes: true,
            attributeFilter: ['src', 'currentSrc'],
        });
    }

    // ===== 监听视频上的用户操作事件（暂停/播放/音量） =====
    function bindVideoEvents(video) {
        if (video._buaaEventsBound) return;
        video._buaaEventsBound = true;

        video.addEventListener('pause', () => {
            if (cloneVideo && !cloneVideo.paused) {
                cloneVideo.pause();
            }
        });
        video.addEventListener('play', () => {
            if (cloneVideo && cloneVideo.paused) {
                cloneVideo.play().catch(() => {});
                // 同步时间
                if (video.currentTime > 0) cloneVideo.currentTime = video.currentTime;
            }
        });
        video.addEventListener('volumechange', () => {
            if (cloneVideo) {
                cloneVideo.volume = video.volume || 1.0;
                cloneVideo.muted = video.muted;
            }
        });
        video.addEventListener('seeked', () => {
            if (cloneVideo && video.currentTime > 0) {
                cloneVideo.currentTime = video.currentTime;
            }
        });
    }

    // ===== 扫描 =====
    function scanAndSetup() {
        if (!syncEnabled) return;

        // 仅在教师视频仍在播放时，才恢复意外暂停的克隆
        if (cloneVideo && cloneVideo.paused && teacherVideo && !teacherVideo.paused) {
            cloneVideo.play().catch(() => {});
        }
        if (cloneAudioCtx && cloneAudioCtx.state === 'suspended') {
            cloneAudioCtx.resume().catch(() => {});
        }

        // 找教师流
        const videos = document.querySelectorAll('video');
        let found = null;
        for (const v of videos) {
            if (isTeacherStream(v)) { found = v; break; }
        }

        if (found && found !== teacherVideo) {
            log('🔍 发现教师流');
            teacherVideo = found;
            savedTeacherSrc = found.src || found.currentSrc;
            bindVideoEvents(teacherVideo);
            createCloneVideo(teacherVideo);
            startTimeSync();
            startSrcWatch(teacherVideo);
            logVideoState(teacherVideo, '初始');
        }

        if (!found && teacherVideo) {
            // 教师视频消失
            teacherVideo = null;
        }

        updatePanel();
    }

    // ===== 状态日志 =====
    function logVideoState(video, label) {
        if (!video) return;
        log(`📊 [${label}] src=`, (video.src || '').substring(0, 55));
        log(`   paused=${video.paused} time=${video.currentTime.toFixed(1)} inDOM=${document.contains(video)}`);
        if (cloneVideo) log(`   🎬 克隆 paused=${cloneVideo.paused} time=${cloneVideo.currentTime.toFixed(1)}`);
        log(`   isOnPPT=${isOnPPT}`);
    }

    // ===== 浮动面板 =====
    function createPanel() {
        if (panelEl) return;
        panelEl = document.createElement('div');
        panelEl.id = 'buaa-audio-sync-panel';
        panelEl.innerHTML = `
            <style>
                #buaa-audio-sync-panel {
                    position: fixed; bottom: 20px; right: 20px; z-index: 99999;
                    background: rgba(0,71,157,0.9); color: #fff; border-radius: 10px;
                    padding: 10px 14px; font-size: 13px;
                    font-family: "Microsoft YaHei","PingFang SC",sans-serif;
                    cursor: pointer; user-select: none;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
                    display: flex; align-items: center; gap: 8px;
                    transition: all 0.3s; backdrop-filter: blur(6px);
                }
                #buaa-audio-sync-panel:hover { transform: translateY(-2px); }
                #buaa-audio-sync-panel .dot {
                    width: 10px; height: 10px; border-radius: 50%;
                    background: #4caf50; box-shadow: 0 0 8px #4caf50; flex-shrink: 0;
                }
                #buaa-audio-sync-panel.off .dot { background: #999; box-shadow: none; }
                #buaa-audio-sync-panel.ppt .dot { background: #ff9800; box-shadow: 0 0 8px #ff9800; }
                #buaa-audio-sync-panel .text { line-height: 1.3; }
                #buaa-audio-sync-panel .label { font-weight: bold; }
                #buaa-audio-sync-panel .hint { font-size: 11px; opacity: 0.7; }
            </style>
            <div class="dot"></div>
            <div class="text">
                <div class="label">🎵 音源同步 v6</div>
                <div class="hint">点击切换</div>
            </div>
        `;
        panelEl.addEventListener('click', () => {
            syncEnabled = !syncEnabled;
            if (!syncEnabled) { teardownClone(); teacherVideo = null; isOnPPT = false; }
            else scanAndSetup();
            updatePanel();
        });
        document.body.appendChild(panelEl);
    }

    function updatePanel() {
        if (!panelEl) return;
        const hintEl = panelEl.querySelector('.hint');
        const labelEl = panelEl.querySelector('.label');
        panelEl.classList.remove('off', 'ppt');
        if (!syncEnabled) {
            panelEl.classList.add('off');
            labelEl.textContent = '🔇 已暂停';
            hintEl.textContent = '点击恢复';
        } else if (isOnPPT && cloneVideo && !cloneVideo.paused) {
            panelEl.classList.add('ppt');
            labelEl.textContent = '🎵 PPT视图';
            hintEl.textContent = '暂停/音量可控';
        } else if (cloneVideo && !cloneVideo.paused) {
            labelEl.textContent = '🎵 音源同步';
            hintEl.textContent = '暂停/音量同步';
        } else {
            labelEl.textContent = '🎵 音源同步';
            hintEl.textContent = '等待...';
        }
    }

    // ===== DOM 监听 =====
    function startObserver() {
        const observer = new MutationObserver((mutations) => {
            for (const mut of mutations) {
                for (const node of mut.removedNodes) {
                    if (node === teacherVideo || (node.contains && teacherVideo && node.contains(teacherVideo))) {
                        log('⚠ 教师视频被移除');
                        if (srcWatcher) { srcWatcher.disconnect(); srcWatcher = null; }
                        teacherVideo = null;
                        setTimeout(() => scanAndSetup(), 500);
                    }
                    if (node === cloneVideo || (node.contains && cloneVideo && node.contains(cloneVideo))) {
                        log('⚠ 克隆被移除, 重建');
                        cloneVideo = null;
                        if (savedTeacherSrc && syncEnabled)
                            setTimeout(() => { if (teacherVideo) createCloneVideo(teacherVideo); }, 500);
                    }
                }
                for (const node of mut.addedNodes) {
                    let found = false;
                    if (node.nodeName === 'VIDEO') found = true;
                    else if (node.querySelectorAll && node.querySelectorAll('video').length > 0) found = true;
                    if (found) setTimeout(() => scanAndSetup(), 300);
                }
            }
        });
        const start = () => {
            if (document.body) { observer.observe(document.body, { childList: true, subtree: true }); }
            else setTimeout(start, 500);
        };
        start();
    }

    window.addEventListener('beforeunload', () => { teardownClone(); });

    // ===== 初始化 =====
    function init() {
        log('═══ 智学北航 PPT音源同步 v6.1 ═══');
        const tryCreatePanel = () => {
            if (document.body) { createPanel(); updatePanel(); }
            else setTimeout(tryCreatePanel, 500);
        };
        tryCreatePanel();
        scanAndSetup();
        setInterval(scanAndSetup, SCAN_INTERVAL);
        startObserver();
        log('✨ 就绪');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
