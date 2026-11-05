/*!
 * dino-runner.js — 可离线运行的 2D 像素跑酷（原生 Canvas，零外部依赖）
 * 主角：像素火柴人（黑身 + 荧光绿描边 + 黄王冠，纯栅格化生成）
 * ------------------------------------------------------------------
 * 设计要点（对应技术规格）：
 *   1. 原生 HTML5 + Vanilla JS，不使用任何框架，不发任何网络请求；
 *   2. Canvas 渲染 + requestAnimationFrame 主循环；
 *   3. Delta Time 归一化：所有位移乘 timeScale，60Hz / 144Hz 手感一致；
 *   4. 栅格化像素素材（无外部图片 / 字体 / 音频）；
 *   5. 公平生成：间距由「滞空帧数」反推，保证任何速度下都能跳过去；
 *   6. 最高分写入 localStorage，读写失败自动降级。
 */
(function (global) {
  'use strict';

  // ================================================================
  // 1. 配置（调参只需要改这里）
  // ================================================================
  var Config = {
    // 逻辑画布尺寸：所有游戏坐标都在这套坐标系内计算，与屏幕像素无关
    VIEW_W: 800,
    VIEW_H: 260,
    GROUND_Y: 206,

    // 物理与速度（单位：像素 / 帧 @60fps，由 timeScale 归一化）
    GRAVITY: 0.55, // 重力加速度
    JUMP_VELOCITY: -12.4, // 起跳初速度（负值向上）
    INITIAL_SPEED: 6, // 初速
    MAX_SPEED: 13.5, // 速度上限
    ACCELERATION: 0.0009, // 每帧加速度（约 140 秒提速到上限）

    // 玩家
    PLAYER_X: 64,
    PLAYER_W: 30,
    PLAYER_H: 46,
    PLAYER_DUCK_W: 44,
    PLAYER_DUCK_H: 30,
    DUCK_MIN_FRAMES: 26, // 一次下蹲至少需要的帧数（用于安全间距）

    // 障碍
    OBSTACLE_MAX: 6,
    MIN_INTERVAL: 28, // 相邻障碍的最小生成间隔（帧）
    SAFE_BUFFER: 12, // 额外安全缓冲（帧）
    SPAWN_X: 830,
    CACTUS_MIN_H: 24,
    CACTUS_MAX_H: 46,
    CACTUS_UNIT_W: 16,
    BIRD_W: 46,
    BIRD_H: 24,
    BIRD_BOTTOM: 38, // 飞鸟底边距地面的高度（站在地上会撞到，蹲下能过）

    // 分数
    SCORE_KEY: 'yoru-dino-best',
    SCORE_RATE: 0.14, // 基础得分率
    SCORE_SPEED_BONUS: 0.3, // 速度加成
    HUD_PAD: 5
  };

  var STATE = { WAITING: 'WAITING', RUNNING: 'RUNNING', GAME_OVER: 'GAME_OVER' };

  // ================================================================
  // 2. 小工具
  // ================================================================
  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  function pad(n, len) {
    var s = String(Math.floor(n));
    while (s.length < len) s = '0' + s;
    return s;
  }

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function randInt(min, max) {
    return Math.floor(rand(min, max + 1));
  }

  // 圆角矩形（不依赖 ctx.roundRect，兼容老浏览器）
  function roundRect(ctx, x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // 读取主题 CSS 变量，保证亮色 / 暗色主题都协调
  function cssVar(name, fallback) {
    try {
      var v = global.getComputedStyle(document.documentElement).getPropertyValue(name);
      v = (v || '').trim();
      return v || fallback;
    } catch (e) {
      return fallback;
    }
  }

  // ================================================================
  // 3. 素材（纯几何绘制，无外部图片）
  // ================================================================

  // ================================================================
  // 3.5 像素风火柴人（栅格化生成，无外部图片）
  //     造型：黑色身体 + 荧光绿描边 + 黄色小皇冠；黑色部分跟随主题文字色
  // ================================================================
  var PixelArt = (function () {
    var CELL = 2; // 每个“像素块”= 2 个逻辑像素

    function grid(w, h) {
      var rows = [];
      for (var y = 0; y < h; y++) {
        var row = [];
        for (var x = 0; x < w; x++) row.push(0);
        rows.push(row);
      }
      return rows;
    }

    function distSeg(px, py, x1, y1, x2, y2) {
      var dx = x2 - x1;
      var dy = y2 - y1;
      var len2 = dx * dx + dy * dy;
      var t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      var cx = x1 + dx * t;
      var cy = y1 + dy * t;
      var ex = px - cx;
      var ey = py - cy;
      return Math.sqrt(ex * ex + ey * ey);
    }

    // 粗线段（cell 坐标）
    function line(g, x1, y1, x2, y2, thickness) {
      var r = Math.max(0.42, thickness / 2);
      var y0 = Math.max(0, Math.floor(Math.min(y1, y2) - r));
      var y1c = Math.min(g.length - 1, Math.ceil(Math.max(y1, y2) + r));
      var x0 = Math.max(0, Math.floor(Math.min(x1, x2) - r));
      var x1c = Math.min(g[0].length - 1, Math.ceil(Math.max(x1, x2) + r));
      for (var y = y0; y <= y1c; y++) {
        for (var x = x0; x <= x1c; x++) {
          if (distSeg(x + 0.5, y + 0.5, x1, y1, x2, y2) <= r) g[y][x] = 1;
        }
      }
    }

    // 折线
    function poly(g, pts, thickness) {
      for (var i = 0; i < pts.length - 1; i++) {
        line(g, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], thickness);
      }
    }

    function disc(g, cx, cy, r) {
      for (var y = 0; y < g.length; y++) {
        for (var x = 0; x < g[0].length; x++) {
          var dx = x + 0.5 - cx;
          var dy = y + 0.5 - cy;
          if (dx * dx + dy * dy <= r * r) g[y][x] = 1;
        }
      }
    }

    function block(g, x1, y1, x2, y2) {
      for (var y = Math.max(0, y1); y <= Math.min(g.length - 1, y2); y++) {
        for (var x = Math.max(0, x1); x <= Math.min(g[0].length - 1, x2); x++) g[y][x] = 1;
      }
    }

    // 王冠：冠带 + 三个尖角，cx 为水平中心，baseY 为冠带最下一行
    function crown(c, cx, baseY) {
      block(c, cx - 2, baseY - 1, cx + 2, baseY);
      block(c, cx - 2, baseY - 2, cx - 2, baseY - 2);
      block(c, cx, baseY - 2, cx, baseY - 2);
      block(c, cx + 2, baseY - 2, cx + 2, baseY - 2);
    }

    // 合成「绿描边 + 黑身 + 黄冠」
    function build(w, h, painter) {
      var body = grid(w, h);
      var hat = grid(w, h);
      painter(body, hat);

      // 描边只跟随黑色身体（王冠保持纯黄色，更有辨识度）
      var ring = grid(w, h);
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          if (body[y][x] || hat[y][x]) continue;
          var hit = false;
          for (var dy = -1; dy <= 1 && !hit; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              var nx = x + dx;
              var ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              if (body[ny][nx]) {
                hit = true;
                break;
              }
            }
          }
          if (hit) ring[y][x] = 1;
        }
      }

      function collect(src) {
        var out = [];
        for (var yy = 0; yy < h; yy++) {
          for (var xx = 0; xx < w; xx++) {
            if (src[yy][xx]) out.push([xx * CELL, yy * CELL]);
          }
        }
        return out;
      }

      return { w: w * CELL, h: h * CELL, ring: collect(ring), body: collect(body), crown: collect(hat) };
    }

    // ---- 奔跑（单帧静态姿势，不做交替动画）----
    function runPose() {
      return build(16, 22, function (g, c) {
        disc(g, 8, 5.2, 2.6);
        crown(c, 8, 2);
        poly(g, [[8, 8.0], [8.2, 9.4], [8.4, 13.2]], 1.0); // 脖子 + 躯干
        poly(g, [[8.4, 9.6], [11.2, 9.2], [13.4, 7.0]], 1.0); // 前臂向前上
        poly(g, [[7.9, 9.8], [5.2, 11.2], [3.4, 13.6]], 1.0); // 后臂向后下
        poly(g, [[8.6, 13.2], [10.8, 15.4], [11.9, 18.3], [13.7, 19.1]], 1.0); // 前腿
        poly(g, [[8.2, 13.2], [6.3, 15.8], [5.0, 18.6], [3.1, 19.8]], 1.0); // 后腿
      });
    }

    // ---- 跳跃（双腿收起、双臂上扬）----
    function jumpPose() {
      return build(16, 22, function (g, c) {
        disc(g, 8, 5.2, 2.6);
        crown(c, 8, 2);
        poly(g, [[8, 8.0], [8.2, 9.4], [8.4, 13.0]], 1.0);
        poly(g, [[8.4, 9.6], [5.6, 8.4], [4.2, 6.0]], 1.0);
        poly(g, [[7.9, 9.8], [10.4, 8.4], [12.4, 6.2]], 1.0);
        poly(g, [[8.6, 13.0], [10.5, 14.9], [12.4, 15.5]], 1.0);
        poly(g, [[8.2, 13.0], [6.3, 14.7], [4.5, 14.3]], 1.0);
      });
    }

    // ---- 下蹲（横向压缩）----
    function duckPose() {
      return build(22, 13, function (g, c) {
        disc(g, 16.4, 5.4, 2.6);
        crown(c, 16, 2);
        poly(g, [[14.4, 7.4], [10.6, 8.2], [7.4, 8.8]], 1.1); // 躯干贴地
        poly(g, [[12.2, 7.8], [10.3, 10.3], [11.7, 11.7]], 1.0); // 手撑地
        poly(g, [[8.4, 8.9], [6.2, 10.9], [3.7, 12.2]], 1.0); // 收腿
        poly(g, [[8.7, 9.1], [7.1, 11.3], [4.9, 12.5]], 1.0);
      });
    }

    var poses = {
      run: runPose(), // 静态奔跑姿势（不做两帧交替）
      jump: jumpPose(),
      duck: duckPose()
    };

    function paint(ctx, cells, x, y) {
      if (!cells.length) return;
      ctx.beginPath();
      for (var i = 0; i < cells.length; i++) {
        ctx.rect(x + cells[i][0], y + cells[i][1], CELL, CELL);
      }
      ctx.fill();
    }

    return {
      CELL: CELL,
      poses: poses,
      draw: function (ctx, pose, x, y, colors) {
        ctx.save();
        ctx.fillStyle = colors.green;
        paint(ctx, pose.ring, x, y);
        ctx.fillStyle = colors.ink;
        paint(ctx, pose.body, x, y);
        ctx.fillStyle = colors.crown;
        paint(ctx, pose.crown, x, y);
        ctx.restore();
      }
    };
  })();

  var Assets = {
    // 玩家：像素风火柴人（脚底居中于碰撞箱）
    drawPlayer: function (ctx, player, colors) {
      var ducking = player.ducking && player.onGround;
      var pose;
      if (ducking) pose = PixelArt.poses.duck;
      else if (!player.onGround) pose = PixelArt.poses.jump;
      else pose = PixelArt.poses.run;

      var boxW = ducking ? Config.PLAYER_DUCK_W : Config.PLAYER_W;
      var x = Math.round(player.x + (boxW - pose.w) / 2);
      var y = Math.round(player.y - pose.h);
      PixelArt.draw(ctx, pose, x, y, colors);
    },

    // 地面仙人掌：脚底贴地
    drawCactus: function (ctx, o, colors) {
      var x = o.x;
      var y = o.y + o.h; // 底部
      ctx.save();
      ctx.fillStyle = colors.muted;
      ctx.strokeStyle = colors.muted;
      ctx.lineWidth = 2;

      var unit = 16;
      var count = Math.max(1, Math.round((o.w + 4) / (unit + 4)));
      for (var i = 0; i < count; i++) {
        var bx = x + i * (unit + 4);
        var bh = o.h - (i % 2 === 0 ? 0 : 8);
        roundRect(ctx, bx, y - bh, unit, bh, 6);
        ctx.fill();
        // 手臂
        if (bh > 26) {
          roundRect(ctx, bx - 5, y - bh + 12, 5, 12, 2.5);
          ctx.fill();
          roundRect(ctx, bx + unit, y - bh + 6, 5, 10, 2.5);
          ctx.fill();
        }
      }
      ctx.restore();
    },

    // 飞鸟：定时扇翅
    drawBird: function (ctx, o, colors, t) {
      var x = o.x;
      var y = o.y;
      var w = o.w;
      var h = o.h;
      var flap = Math.sin(t * 0.35) * 5;

      ctx.save();
      ctx.fillStyle = colors.muted;
      ctx.beginPath();
      ctx.ellipse(x + w * 0.55, y + h * 0.55, w * 0.28, h * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();

      // 头 + 喙
      ctx.beginPath();
      ctx.arc(x + w * 0.86, y + h * 0.42, h * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + w * 0.98, y + h * 0.4);
      ctx.lineTo(x + w * 1.12, y + h * 0.48);
      ctx.lineTo(x + w * 0.98, y + h * 0.56);
      ctx.closePath();
      ctx.fill();

      // 翅膀
      ctx.beginPath();
      ctx.moveTo(x + w * 0.5, y + h * 0.5);
      ctx.lineTo(x + w * 0.12, y + h * 0.36 - flap);
      ctx.lineTo(x + w * 0.34, y + h * 0.62);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + w * 0.56, y + h * 0.52);
      ctx.lineTo(x + w * 0.24, y + h * 0.78 + flap);
      ctx.lineTo(x + w * 0.58, y + h * 0.7);
      ctx.closePath();
      ctx.fill();

      // 眼睛
      ctx.fillStyle = colors.bg;
      ctx.beginPath();
      ctx.arc(x + w * 0.9, y + h * 0.38, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };

  // ================================================================
  // 4. 计分（localStorage 安全降级）
  // ================================================================
  var ScoreManager = {
    read: function () {
      try {
        var raw = global.localStorage ? global.localStorage.getItem(Config.SCORE_KEY) : null;
        var n = parseInt(raw, 10);
        return isFinite(n) && n > 0 ? n : 0;
      } catch (e) {
        return 0;
      }
    },
    write: function (value) {
      try {
        if (global.localStorage) {
          global.localStorage.setItem(Config.SCORE_KEY, String(Math.floor(value)));
        }
      } catch (e) {
        /* 隐私模式 / 配额满：无需处理，游戏继续 */
      }
    }
  };

  // ================================================================
  // 5. 玩家
  // ================================================================
  function Player() {
    this.reset();
  }

  Player.prototype.reset = function () {
    this.x = Config.PLAYER_X;
    this.y = Config.GROUND_Y; // y = 脚底位置
    this.vy = 0;
    this.onGround = true;
    this.ducking = false;
    this.duckFrames = 0;
  };

  Player.prototype.jump = function () {
    if (!this.onGround) return false; // 不允许二段跳
    this.vy = Config.JUMP_VELOCITY;
    this.onGround = false;
    this.ducking = false;
    return true;
  };

  Player.prototype.setDuck = function (on) {
    if (on) {
      if (!this.onGround) return; // 空中不能下蹲
      this.ducking = true;
      this.duckFrames = 0;
    } else {
      this.ducking = false;
    }
  };

  Player.prototype.update = function (timeScale) {

    if (!this.onGround) {
      this.vy += Config.GRAVITY * timeScale;
      this.y += this.vy * timeScale;
      if (this.y >= Config.GROUND_Y) {
        this.y = Config.GROUND_Y;
        this.vy = 0;
        this.onGround = true;
      }
    }
    if (this.ducking && this.onGround) this.duckFrames += timeScale;
  };

  Player.prototype.box = function () {
    var ducking = this.ducking && this.onGround;
    var w = ducking ? Config.PLAYER_DUCK_W : Config.PLAYER_W;
    var h = ducking ? Config.PLAYER_DUCK_H : Config.PLAYER_H;
    var pad = 4; // 碰撞箱略小于视觉，提升手感
    return { x: this.x + pad, y: this.y - h + pad, w: w - pad * 2, h: h - pad * 2 };
  };

  // ================================================================
  // 6. 障碍物（含公平生成逻辑）
  // ================================================================
  function ObstacleManager() {
    this.reset();
  }

  ObstacleManager.prototype.reset = function () {
    this.items = [];
    this.distSinceSpawn = 0;
    this.lastKind = null;
    this.spawned = 0;
    this.spawnLog = []; // 调试用：记录每次生成的间距决策
  };

  // 滞空帧数：2 * v0 / g
  ObstacleManager.prototype.airtimeFrames = function () {
    return Math.ceil((2 * Math.abs(Config.JUMP_VELOCITY)) / Config.GRAVITY);
  };

  /**
   * 公平生成的核心：相邻障碍之间的“时间距离”必须大于
   *  上一障碍的清除时间（跳跃滞空 / 下蹲保持）+ 反应缓冲。
   * 因为间距以帧为单位反推，速度提升时间距等比放大，
   * 所以任何速度下都不会出现“跳不过去”的组合。
   */
  ObstacleManager.prototype.requiredGapFrames = function () {
    if (!this.lastKind) return Config.MIN_INTERVAL;
    var clearance = this.lastKind === 'bird' ? Config.DUCK_MIN_FRAMES : this.airtimeFrames();
    return Math.max(Config.MIN_INTERVAL, Math.ceil(clearance + Config.SAFE_BUFFER));
  };

  ObstacleManager.prototype.pickKind = function (difficulty) {
    // 起飞阶段只出地面障碍，之后逐渐引入飞鸟
    if (difficulty < 0.1) return 'cactus';
    return Math.random() < 0.32 ? 'bird' : 'cactus';
  };

  ObstacleManager.prototype.makeObstacle = function (kind, speed) {
    if (kind === 'bird') {
      return {
        kind: 'bird',
        x: Config.SPAWN_X,
        y: Config.GROUND_Y - Config.BIRD_BOTTOM - Config.BIRD_H,
        w: Config.BIRD_W,
        h: Config.BIRD_H,
        speed: speed
      };
    }
    var count = 1;
    var r = Math.random();
    if (r > 0.82) count = 3;
    else if (r > 0.55) count = 2;
    var w = count * Config.CACTUS_UNIT_W + (count - 1) * 4;
    var h = rand(Config.CACTUS_MIN_H, Config.CACTUS_MAX_H);
    return {
      kind: 'cactus',
      x: Config.SPAWN_X,
      y: Config.GROUND_Y - h,
      w: w,
      h: h,
      speed: speed
    };
  };

  ObstacleManager.prototype.update = function (timeScale, speed, difficulty) {
    var i, o;

    // 移动 + 回收
    for (i = this.items.length - 1; i >= 0; i--) {
      o = this.items[i];
      o.x -= o.speed * timeScale;
      if (o.x + o.w < -40) this.items.splice(i, 1);
    }

    // 生成：以“已跑距离 >= 速度 × 安全帧数”为闸门
    this.distSinceSpawn += speed * timeScale;
    var gapFrames = this.requiredGapFrames();
    var needDist = speed * gapFrames;

    if (this.distSinceSpawn >= needDist && this.items.length < Config.OBSTACLE_MAX) {
      var kind = this.pickKind(difficulty);
      var obstacle = this.makeObstacle(kind, speed);
      this.items.push(obstacle);
      this.spawnLog.push({
        kind: kind,
        w: obstacle.w,
        speed: speed,
        gapFrames: gapFrames,
        gapPx: Math.round(needDist)
      });
      this.lastKind = kind;
      this.spawned += 1;
      this.distSinceSpawn = 0;
    }
  };

  ObstacleManager.prototype.boxOf = function (o) {
    var padX = 3;
    var padY = o.kind === 'bird' ? 5 : 3;
    return { x: o.x + padX, y: o.y + padY, w: o.w - padX * 2, h: o.h - padY * 2 };
  };

  // ================================================================
  // 7. 背景（云 + 地面滚动）
  // ================================================================
  function Background() {
    this.reset();
  }

  Background.prototype.reset = function () {
    this.offset = 0;
    this.clouds = [];
    for (var i = 0; i < 3; i++) {
      this.clouds.push({
        x: rand(0, Config.VIEW_W),
        y: rand(40, 120),
        s: rand(0.7, 1.25)
      });
    }
  };

  Background.prototype.update = function (timeScale, speed) {
    this.offset = (this.offset + speed * timeScale) % 60;
    for (var i = 0; i < this.clouds.length; i++) {
      var c = this.clouds[i];
      c.x -= speed * timeScale * 0.22;
      if (c.x < -80) {
        c.x = Config.VIEW_W + rand(20, 160);
        c.y = rand(40, 120);
        c.s = rand(0.7, 1.25);
      }
    }
  };

  Background.prototype.draw = function (ctx, colors) {
    var i;
    // 云
    ctx.save();
    ctx.fillStyle = colors.muted;
    ctx.globalAlpha = 0.28;
    for (i = 0; i < this.clouds.length; i++) {
      var c = this.clouds[i];
      var cx = c.x;
      var cy = c.y;
      var r = 14 * c.s;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.arc(cx + r * 1.1, cy + 3, r * 0.8, 0, Math.PI * 2);
      ctx.arc(cx - r * 1.1, cy + 4, r * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 地面线 + 滚动虚线
    ctx.save();
    ctx.strokeStyle = colors.muted;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, Config.GROUND_Y + 1);
    ctx.lineTo(Config.VIEW_W, Config.GROUND_Y + 1);
    ctx.stroke();

    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var x = -this.offset; x < Config.VIEW_W; x += 60) {
      ctx.moveTo(x, Config.GROUND_Y + 8);
      ctx.lineTo(x + 26, Config.GROUND_Y + 8);
    }
    ctx.stroke();
    ctx.restore();
  };

  // ================================================================
  // 8. 输入管理
  // ================================================================
  function InputManager(runner, canvas) {
    this.runner = runner;
    this.canvas = canvas;
    this.touchStartY = 0;
    this.touching = false;
    this.bind();
  }

  var JUMP_KEYS = { ' ': 1, Spacebar: 1, ArrowUp: 1, w: 1, W: 1, Enter: 1 };
  var DUCK_KEYS = { ArrowDown: 1, s: 1, S: 1 };

  InputManager.prototype.bind = function () {
    var self = this;
    var canvas = this.canvas;

    canvas.addEventListener('keydown', function (e) {
      if (JUMP_KEYS[e.key] || e.keyCode === 32 || e.keyCode === 38 || e.keyCode === 13) {
        e.preventDefault();
        self.runner.onJumpKey();
      } else if (DUCK_KEYS[e.key] || e.keyCode === 40) {
        e.preventDefault();
        self.runner.onDuckKey(true);
      }
    });

    canvas.addEventListener('keyup', function (e) {
      if (DUCK_KEYS[e.key] || e.keyCode === 40) {
        e.preventDefault();
        self.runner.onDuckKey(false);
      }
    });

    // 鼠标 / 触屏点击：开始、跳跃、重开
    canvas.addEventListener('pointerdown', function (e) {
      if (e.button && e.button !== 0) return;
      canvas.focus({ preventScroll: true });
      self.runner.onPress();
    });

    canvas.addEventListener('pointerup', function () {
      self.runner.onDuckKey(false);
    });

    // 触屏下滑 = 下蹲（只有画布内才拦截滚动）
    canvas.addEventListener(
      'touchstart',
      function (e) {
        if (!e.touches.length) return;
        self.touching = true;
        self.touchStartY = e.touches[0].clientY;
      },
      { passive: true }
    );

    canvas.addEventListener(
      'touchmove',
      function (e) {
        if (!self.touching || !e.touches.length) return;
        var dy = e.touches[0].clientY - self.touchStartY;
        if (dy > 18) {
          if (e.cancelable) e.preventDefault();
          self.runner.onDuckKey(true);
        }
      },
      { passive: false }
    );

    canvas.addEventListener(
      'touchend',
      function () {
        self.touching = false;
        self.runner.onDuckKey(false);
      },
      { passive: true }
    );
  };

  // ================================================================
  // 9. 游戏主控
  // ================================================================
  function Runner(canvas, ui) {
    this.canvas = canvas;
    this.ctx = canvas.getContext ? canvas.getContext('2d') : null;
    this.ui = ui || {};
    this.player = new Player();
    this.obstacles = new ObstacleManager();
    this.background = new Background();
    this.input = new InputManager(this, canvas);

    this.state = STATE.WAITING;
    this.score = 0;
    this.best = ScoreManager.read();
    this.speed = Config.INITIAL_SPEED;
    this.frames = 0;
    this.lastTime = 0;
    this.scale = 1;
    this.visible = true;
    this.colors = this.readColors();
    this.boundTick = this.tick.bind(this);

    this.resize();
    this.updateHud();
    this.setOverlay('点击画布或按空格开始', true);
    this.render();

    var self = this;
    global.addEventListener('resize', function () {
      self.resize();
      self.render();
    });
    if (global.document) {
      global.document.addEventListener('visibilitychange', function () {
        if (global.document.hidden) self.lastTime = 0; // 切回前台时避免巨大步进
      });
    }
    // 滚出视口时暂停渲染（IntersectionObserver 不可用时保持常开）
    if (global.IntersectionObserver) {
      try {
        this.observer = new global.IntersectionObserver(
          function (entries) {
            self.setVisible(entries[0] ? entries[0].isIntersecting : true);
          },
          { threshold: 0 }
        );
        this.observer.observe(canvas);
      } catch (e) {
        this.observer = null;
      }
    }

    global.requestAnimationFrame(this.boundTick);
  }

  Runner.prototype.readColors = function () {
    return {
      ink: cssVar('--text-color', '#171717'),
      muted: cssVar('--secondary-text-color', '#6f6f6f'),
      bg: cssVar('--secondary-color', '#ffffff'),
      green: '#4ade80', // 像素描边（荧光绿）
      crown: '#f5b81c' // 皇冠（黄）
    };
  };

  Runner.prototype.difficulty = function () {
    return clamp((this.speed - Config.INITIAL_SPEED) / (Config.MAX_SPEED - Config.INITIAL_SPEED), 0, 1);
  };

  Runner.prototype.resize = function () {
    var dpr = global.devicePixelRatio || 1;
    var cssW = 0;
    try {
      cssW = this.canvas.clientWidth || (this.canvas.getBoundingClientRect ? this.canvas.getBoundingClientRect().width : 0);
    } catch (e) {
      cssW = 0;
    }
    if (!cssW) cssW = 800;

    var cssH = (cssW * Config.VIEW_H) / Config.VIEW_W;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.scale = (cssW * dpr) / Config.VIEW_W;
  };

  Runner.prototype.start = function () {
    if (this.state === STATE.RUNNING) return;
    this.player.reset();
    this.obstacles.reset();
    this.background.reset();
    this.score = 0;
    this.speed = Config.INITIAL_SPEED;
    this.frames = 0;
    this.lastTime = 0;
    this.state = STATE.RUNNING;
    this.setOverlay('', false);
    this.updateHud();
  };

  Runner.prototype.gameOver = function () {
    if (this.state !== STATE.RUNNING) return;
    this.state = STATE.GAME_OVER;
    if (this.score > this.best) {
      this.best = Math.floor(this.score);
      ScoreManager.write(this.best);
    }
    this.setOverlay('游戏结束 · 得分 ' + pad(this.score, Config.HUD_PAD) + '，点击或按空格重来', true);
    this.updateHud();
  };

  Runner.prototype.onPress = function () {
    if (this.state === STATE.RUNNING) {
      this.player.jump();
      return;
    }
    this.start();
    this.player.jump();
  };

  Runner.prototype.onJumpKey = function () {
    this.onPress();
  };

  Runner.prototype.onDuckKey = function (on) {
    if (this.state !== STATE.RUNNING) return;
    this.player.setDuck(on);
  };

  Runner.prototype.updateHud = function () {
    if (this.ui.scoreEl) this.ui.scoreEl.textContent = pad(this.score, Config.HUD_PAD);
    if (this.ui.bestEl) this.ui.bestEl.textContent = pad(this.best, Config.HUD_PAD);
  };

  Runner.prototype.setOverlay = function (text, visible) {
    if (!this.ui.overlay) return;
    if (this.ui.overlayText) this.ui.overlayText.textContent = text;
    this.ui.overlay.style.display = visible ? 'flex' : 'none';
  };

  Runner.prototype.update = function (timeScale) {
    this.frames += timeScale;
    var speedBefore = this.speed;
    this.speed = clamp(this.speed + Config.ACCELERATION * timeScale, Config.INITIAL_SPEED, Config.MAX_SPEED);
    // 用梯形积分（帧内平均速度）累加分数，保证 60Hz / 144Hz 结果一致
    var avgSpeed = (speedBefore + this.speed) / 2;

    var diff = this.difficulty();
    this.player.update(timeScale);
    this.background.update(timeScale, this.speed);
    this.obstacles.update(timeScale, this.speed, diff);

    // 分数：随距离增长，速度越快增长越快
    this.score += avgSpeed * timeScale * (Config.SCORE_RATE + Config.SCORE_SPEED_BONUS * diff);

    // 碰撞（AABB）
    var pb = this.player.box();
    for (var i = 0; i < this.obstacles.items.length; i++) {
      if (rectsOverlap(pb, this.obstacles.boxOf(this.obstacles.items[i]))) {
        this.gameOver();
        break;
      }
    }
    this.updateHud();
  };

  Runner.prototype.render = function () {
    var ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.clearRect(0, 0, Config.VIEW_W, Config.VIEW_H);

    this.background.draw(ctx, this.colors);

    for (var i = 0; i < this.obstacles.items.length; i++) {
      var o = this.obstacles.items[i];
      if (o.kind === 'bird') Assets.drawBird(ctx, o, this.colors, this.frames);
      else Assets.drawCactus(ctx, o, this.colors);
    }

    Assets.drawPlayer(ctx, this.player, this.colors);
  };

  /**
   * 可见性开关：滚出视口后停止渲染与推进（省电，也不会在用户看文章时白跑 60fps）。
   * 由 IntersectionObserver 调用；不支持该 API 的环境始终视为可见。
   */
  Runner.prototype.setVisible = function (visible) {
    this.visible = !!visible;
    if (!this.visible) this.lastTime = 0;
  };

  Runner.prototype.tick = function (now) {
    var dtMs = this.lastTime ? now - this.lastTime : 1000 / 60;
    this.lastTime = now;
    // 限制单帧步进，防止切标签回来后物体瞬移
    dtMs = clamp(dtMs, 0, 60);
    var timeScale = dtMs / (1000 / 60);

    if (this.visible) {
      if (this.state === STATE.RUNNING) this.update(timeScale);
      this.render();
    }

    global.requestAnimationFrame(this.boundTick);
  };

  // 调试接口：window.Runner.instance_.setSpeed(10)
  Runner.prototype.setSpeed = function (v) {
    this.speed = clamp(v, Config.INITIAL_SPEED, 30);
  };

  // ================================================================
  // 10. 启动
  // ================================================================
  function boot() {
    var canvas = document.getElementById('mini-game-canvas');
    if (!canvas) return;
    var ui = {
      scoreEl: document.getElementById('mini-game-score'),
      bestEl: document.getElementById('mini-game-best'),
      overlay: document.getElementById('mini-game-overlay'),
      overlayText: document.getElementById('mini-game-overlay-text')
    };
    var runner = new Runner(canvas, ui);
    global.Runner = {
      instance_: runner,
      Runner: Runner,
      Config: Config,
      STATE: STATE,
      version: '1.1.0',
      PixelArt: PixelArt
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : this);
