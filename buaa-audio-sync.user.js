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
    let gainNode = null;          // ★ 音量增强节点
    let volumeBoost = 1.0;        // ★ 音量增强倍数（1.0=正常，最大3.0）

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
            // 如果不在 PPT 视图且教师没暂停，取消静音
            if (!isOnPPT && teacherVideo && !teacherVideo.paused && cloneVideo.muted) {
                cloneVideo.muted = false;
            }
        });

        // AudioContext（带音量增强 GainNode）
        try {
            cloneAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            cloneSource = cloneAudioCtx.createMediaElementSource(cloneVideo);
            gainNode = cloneAudioCtx.createGain();
            gainNode.gain.value = volumeBoost;
            cloneSource.connect(gainNode);
            gainNode.connect(cloneAudioCtx.destination);
            if (cloneAudioCtx.state === 'suspended') cloneAudioCtx.resume().catch(() => {});
            log('✅ 克隆 AudioContext state=', cloneAudioCtx.state);
        } catch (e) {
            log('❌ AudioContext 失败:', e.message);
        }

        document.body.appendChild(cloneVideo);
        cloneVideo.play().catch(e => log('⚠ 克隆 play 失败:', e.message));

        // 静音原始视频，防止切回教师流时双音
        originalVideo.muted = true;

        log('✅ 克隆已启动');
    }

    function teardownClone() {
        if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
        if (srcWatcher) { try { srcWatcher.disconnect(); } catch (e) {} srcWatcher = null; }
        if (cloneSource) { try { cloneSource.disconnect(); } catch (e) {} cloneSource = null; }
        if (gainNode) { try { gainNode.disconnect(); } catch (e) {} gainNode = null; }
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
    // ★ 用静音代替暂停/播放，避免 HLS 状态机在后台抖动
    function startTimeSync() {
        if (syncInterval) clearInterval(syncInterval);
        syncInterval = setInterval(() => {
            if (!cloneVideo) return;

            const activeVideo = teacherVideo || document.querySelector('video:not([data-buaa-clone])');
            if (!activeVideo) return;

            // 同步音量（但不同步静音状态，因为用静音模拟暂停）
            if (cloneVideo.volume !== activeVideo.volume && activeVideo.volume > 0.01) {
                cloneVideo.volume = activeVideo.volume;
            }
            // 同步倍速（仅在教师视图同步克隆→跟用户；PPT 视图不同步，保持克隆原有速度）
            if (!isOnPPT && activeVideo.playbackRate !== 1.0
                && cloneVideo.playbackRate !== activeVideo.playbackRate) {
                cloneVideo.playbackRate = activeVideo.playbackRate;
            }

            // ★ 用静音代替暂停
            if (activeVideo.paused) {
                if (!cloneVideo.muted) cloneVideo.muted = true;  // 静音 = 暂停
                return;
            }

            // 以下：活跃视频在播放中

            // PPT 视图：取消静音即可，不同步时间
            if (isOnPPT) {
                if (cloneVideo.muted) cloneVideo.muted = false;
                return;
            }

            // 教师视图：完整同步
            if (!teacherVideo || !document.contains(teacherVideo)) return;
            if (cloneVideo.muted) cloneVideo.muted = false;
            if (teacherVideo.currentTime > 0) {
                const diff = Math.abs(cloneVideo.currentTime - teacherVideo.currentTime);
                if (diff > 0.5 && teacherVideo.readyState >= 2) {
                    cloneVideo.currentTime = teacherVideo.currentTime;
                }
            }
        }, 300);
    }

    // ★ 音量增强
    function setBoost(delta) {
        volumeBoost = Math.round(Math.max(1.0, Math.min(3.0, volumeBoost + delta)) * 10) / 10;
        if (gainNode) {
            gainNode.gain.value = volumeBoost;
        }
        if (cloneAudioCtx && cloneAudioCtx.state === 'suspended') {
            cloneAudioCtx.resume();
        }
        updatePanel();
        log('🔊 音量增强:', volumeBoost.toFixed(1) + 'x  |  gainNode=', !!gainNode, ' ctx.state=', cloneAudioCtx?.state);
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
                        if (cloneVideo && cloneVideo.muted) cloneVideo.muted = false;
                        if (cloneVideo && video.currentTime > 0) {
                            cloneVideo.currentTime = video.currentTime;
                        }
                        // 保持倍速：PPT 视频也设为克隆的速度
                        if (cloneVideo && cloneVideo.playbackRate !== 1.0) {
                            video.playbackRate = cloneVideo.playbackRate;
                        }
                    } else if (!isPPTSrc(curSrc) && isOnPPT) {
                        log('📺 → 教师视图');
                        isOnPPT = false;
                        if (cloneVideo && teacherVideo && teacherVideo.currentTime > 0) {
                            cloneVideo.currentTime = teacherVideo.currentTime;
                        }
                        if (cloneVideo && cloneVideo.muted) cloneVideo.muted = false;
                        // 恢复倍速
                        if (cloneVideo && cloneVideo.playbackRate !== 1.0) {
                            video.playbackRate = cloneVideo.playbackRate;
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
            if (cloneVideo && !cloneVideo.muted) {
                cloneVideo.muted = true;  // ★ 静音代替暂停
            }
        });
        video.addEventListener('play', () => {
            if (cloneVideo && cloneVideo.muted) {
                cloneVideo.muted = false;
            }
            if (cloneVideo && video.currentTime > 0) {
                cloneVideo.currentTime = video.currentTime;
            }
        });
        video.addEventListener('volumechange', () => {
            if (cloneVideo) {
                // 只同步音量大小，不同步静音状态（因为我们用静音模拟暂停）
                cloneVideo.volume = video.volume || 1.0;
            }
        });
        video.addEventListener('ratechange', () => {
            if (cloneVideo && video.playbackRate > 0) {
                cloneVideo.playbackRate = video.playbackRate;
            }
        });
        video.addEventListener('seeked', () => {
    }

    // ===== 扫描 =====
    function scanAndSetup() {
        if (!syncEnabled) return;

        // 维护克隆：始终保持播放状态（静音代替暂停）
        if (cloneVideo && cloneVideo.paused) {
            cloneVideo.play().catch(() => {});
            cloneVideo.muted = true; // 初始静音，等活跃视频播放时取消
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
        if (cloneVideo) log(`   🎬 克隆 muted=${cloneVideo.muted} time=${cloneVideo.currentTime.toFixed(1)}`);
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
                <div class="label">🎵 音源同步 v7</div>
                <div class="hint">点击切换</div>
            </div>
            <div class="boost" style="display:flex;align-items:center;gap:4px;margin-left:auto;">
                <button class="boost-btn" data-action="boost-down" style="
                    background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);
                    color:#fff;border-radius:6px;width:24px;height:24px;cursor:pointer;
                    font-size:14px;line-height:1;padding:0;">−</button>
                <span class="boost-val" style="font-size:11px;min-width:30px;text-align:center;">1.0x</span>
                <button class="boost-btn" data-action="boost-up" style="
                    background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);
                    color:#fff;border-radius:6px;width:24px;height:24px;cursor:pointer;
                    font-size:14px;line-height:1;padding:0;">+</button>
            </div>
        `;
        // boost 按钮点击不触发面板切换
        panelEl.querySelector('.boost-btn[data-action="boost-up"]').addEventListener('click', (e) => {
            e.stopPropagation(); setBoost(0.2);
        });
        panelEl.querySelector('.boost-btn[data-action="boost-down"]').addEventListener('click', (e) => {
            e.stopPropagation(); setBoost(-0.2);
        });
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
        } else if (isOnPPT && cloneVideo && !cloneVideo.muted) {
            panelEl.classList.add('ppt');
            labelEl.textContent = '🎵 PPT视图';
            hintEl.textContent = '暂停/音量可控';
        } else if (cloneVideo && !cloneVideo.muted) {
            labelEl.textContent = '🎵 音源同步';
            hintEl.textContent = '暂停/音量同步';
        } else {
            labelEl.textContent = '🎵 音源同步';
        // 更新 boost 显示
        const boostVal = panelEl.querySelector('.boost-val');
        if (boostVal) boostVal.textContent = volumeBoost.toFixed(1) + 'x';

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
        log('═══ 智学北航 PPT音源同步 v7.1 ═══');
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
