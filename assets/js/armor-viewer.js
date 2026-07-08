class ArmorViewer {
  constructor(container, skinUrl, armorUrl, leggingsUrl) {
    this.container = container;
    this.skinUrl = skinUrl;
    this.armorUrl = armorUrl;
    this.leggingsUrl = leggingsUrl;
    this.autoRotate = true;
    this.isDragging = false;
    this.prevX = 0;
    this.prevY = 0;
    this.init();
  }

  init() {
    const w = this.container.clientWidth || 200;
    const h = this.container.clientHeight || 280;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    this.camera.position.set(0, 0, 50);

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.container.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 10, 7);
    this.scene.add(dir);

    this.group = new THREE.Group();
    this.group.scale.set(0.75, 0.75, 0.75);
    this.scene.add(this.group);

    this.setupControls();
    this.loadTextures();

    this.resize = this.resize.bind(this);
    if (window.ResizeObserver) {
      new ResizeObserver(this.resize).observe(this.container);
    } else {
      window.addEventListener('resize', this.resize);
    }
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  setupControls() {
    const el = this.renderer.domElement;
    el.style.cursor = 'grab';

    const btn = document.createElement('button');
    btn.textContent = '⏸️';
    btn.style.cssText = 'position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.5);border:none;padding:4px 8px;cursor:pointer;font-size:16px;border-radius:4px;';
    this.container.style.position = 'relative';
    this.container.appendChild(btn);
    btn.onclick = () => {
      this.autoRotate = !this.autoRotate;
      btn.textContent = this.autoRotate ? '⏸️' : '▶️';
    };

    // Mouse events
    el.addEventListener('mousedown', e => {
      this.isDragging = true;
      this.prevX = e.clientX;
      this.prevY = e.clientY;
      el.style.cursor = 'grabbing';
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
      el.style.cursor = 'grab';
    });

    window.addEventListener('mousemove', e => {
      if (this.isDragging) {
        this.group.rotation.y += (e.clientX - this.prevX) * 0.01;
        this.group.rotation.x += (e.clientY - this.prevY) * 0.01;
        this.group.rotation.x = Math.max(-1, Math.min(1, this.group.rotation.x));
        this.prevX = e.clientX;
        this.prevY = e.clientY;
      }
    });

    // Touch events - only rotate when dragging center 1/3 of canvas
    el.addEventListener('touchstart', e => {
      const touch = e.touches[0];
      const rect = el.getBoundingClientRect();
      const relX = touch.clientX - rect.left;
      const third = rect.width / 3;
      if (relX > third && relX < third * 2) {
        this.isDragging = true;
        this.prevX = touch.clientX;
        this.prevY = touch.clientY;
      }
    }, { passive: true });

    el.addEventListener('touchend', () => {
      this.isDragging = false;
    });

    el.addEventListener('touchmove', e => {
      if (this.isDragging) {
        e.preventDefault();
        this.group.rotation.y += (e.touches[0].clientX - this.prevX) * 0.01;
        this.group.rotation.x += (e.touches[0].clientY - this.prevY) * 0.01;
        this.group.rotation.x = Math.max(-1, Math.min(1, this.group.rotation.x));
        this.prevX = e.touches[0].clientX;
        this.prevY = e.touches[0].clientY;
      }
    }, { passive: false });
  }

  loadTextures() {
    const loader = new THREE.TextureLoader();
    loader.crossOrigin = 'anonymous';

    Promise.all([
      new Promise(r => loader.load(this.skinUrl, r)),
      new Promise(r => loader.load(this.armorUrl, t => r(t), undefined, () => r(null))),
      new Promise(r => loader.load(this.leggingsUrl, t => r(t), undefined, () => r(null)))
    ]).then(([skin, armor, leggings]) => {
      skin.magFilter = THREE.NearestFilter;
      skin.minFilter = THREE.NearestFilter;
      if (armor) {
        armor.magFilter = THREE.NearestFilter;
        armor.minFilter = THREE.NearestFilter;
      }
      if (leggings) {
        leggings.magFilter = THREE.NearestFilter;
        leggings.minFilter = THREE.NearestFilter;
      }
      this.buildModel(skin, armor, leggings);
      this.animate();
    });
  }

  uvMap(geo, x, y, w, h, d, tw, th) {
    const uv = geo.attributes.uv;
    const faces = [
      [x, y + d, d, h],
      [x + w + d, y + d, d, h],
      [x + d, y, w, d],
      [x + d + w, y, w, d],
      [x + d, y + d, w, h],
      [x + d + w + d, y + d, w, h]
    ];
    for (let f = 0; f < 6; f++) {
      const [fx, fy, fw, fh] = faces[f];
      const i = f * 4;
      uv.setXY(i, (fx + fw) / tw, 1 - fy / th);
      uv.setXY(i + 1, fx / tw, 1 - fy / th);
      uv.setXY(i + 2, (fx + fw) / tw, 1 - (fy + fh) / th);
      uv.setXY(i + 3, fx / tw, 1 - (fy + fh) / th);
    }
  }

  createPart(w, h, d, tex, uvX, uvY, tw, th, scale = 1) {
    const geo = new THREE.BoxGeometry(w * scale, h * scale, d * scale);
    this.uvMap(geo, uvX, uvY, w, h, d, tw, th);
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.1 }));
  }

  buildModel(skin, armor, leggings) {
    const tw = 64, th = 64, atw = 64, ath = 32;
    const s = 1.1; // armor scale

    // Head
    const head = this.createPart(8, 8, 8, skin, 0, 0, tw, th);
    head.position.y = 12;
    this.group.add(head);
    if (armor) {
      const helmet = this.createPart(8, 8, 8, armor, 0, 0, atw, ath, s);
      helmet.position.y = 12;
      this.group.add(helmet);
    }

    // Body
    const body = this.createPart(8, 12, 4, skin, 16, 16, tw, th);
    body.position.y = 2;
    this.group.add(body);
    if (armor) {
      const chest = this.createPart(8, 12, 4, armor, 16, 16, atw, ath, s);
      chest.position.y = 2;
      this.group.add(chest);
    }

    // Right Arm
    const rArm = this.createPart(4, 12, 4, skin, 40, 16, tw, th);
    rArm.position.set(-6, 2, 0);
    this.group.add(rArm);
    if (armor) {
      const rArmor = this.createPart(4, 12, 4, armor, 40, 16, atw, ath, s);
      rArmor.position.set(-6, 2, 0);
      this.group.add(rArmor);
    }

    // Left Arm
    const lArm = this.createPart(4, 12, 4, skin, 32, 48, tw, th);
    lArm.position.set(6, 2, 0);
    this.group.add(lArm);
    if (armor) {
      const lArmor = this.createPart(4, 12, 4, armor, 40, 16, atw, ath, s);
      lArmor.position.set(6, 2, 0);
      this.group.add(lArmor);
    }

    // Right Leg
    const rLeg = this.createPart(4, 12, 4, skin, 0, 16, tw, th);
    rLeg.position.set(-2, -10, 0);
    this.group.add(rLeg);
    if (leggings) {
      const rLegging = this.createPart(4, 12, 4, leggings, 0, 16, atw, ath, s);
      rLegging.position.set(-2, -10, 0);
      this.group.add(rLegging);
    }
    if (armor) {
      const rBoot = this.createPart(4, 12, 4, armor, 0, 16, atw, ath, 1.15);
      rBoot.position.set(-2, -10, 0);
      this.group.add(rBoot);
    }

    // Left Leg
    const lLeg = this.createPart(4, 12, 4, skin, 16, 48, tw, th);
    lLeg.position.set(2, -10, 0);
    this.group.add(lLeg);
    if (leggings) {
      const lLegging = this.createPart(4, 12, 4, leggings, 0, 16, atw, ath, s);
      lLegging.position.set(2, -10, 0);
      this.group.add(lLegging);
    }
    if (armor) {
      const lBoot = this.createPart(4, 12, 4, armor, 0, 16, atw, ath, 1.15);
      lBoot.position.set(2, -10, 0);
      this.group.add(lBoot);
    }

    this.group.rotation.x = 0.1;
    this.group.rotation.y = -Math.PI / 2;
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    if (this.autoRotate && !this.isDragging) {
      this.group.rotation.y += 0.01;
    }
    this.renderer.render(this.scene, this.camera);
  }
}

window.ArmorViewer = ArmorViewer;
