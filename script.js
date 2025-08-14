const ROOT_NODE_ID = 'root';
const DB_NAME = 'MindMapDB';
const STORE_NAME = 'mindmaps';

class MindMapDB {
    constructor() {
        this.db = null;
    }

    async open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onerror = () => reject("Error opening DB");
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    store.createIndex('name', 'name', { unique: false });
                }
            };
        });
    }

    async getTransaction(mode) {
        if (!this.db) await this.open();
        return this.db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
    }

    async add(map) {
        const store = await this.getTransaction('readwrite');
        return new Promise((resolve, reject) => {
            const request = store.add(map);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    
    async put(map) {
        const store = await this.getTransaction('readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put(map);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async get(id) {
        const store = await this.getTransaction('readonly');
        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getAll() {
        const store = await this.getTransaction('readonly');
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result.sort((a,b) => b.modifiedAt - a.modifiedAt));
            request.onerror = () => reject(request.error);
        });
    }

    async delete(id) {
        const store = await this.getTransaction('readwrite');
        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}


class MindMap {
    constructor(canvasId) {
        // DOM Elements
        this.canvas = document.getElementById(canvasId);
        this.svgLayer = document.getElementById('mindmap-svg-layer');
        this.nodesLayer = document.getElementById('mindmap-nodes-layer');
        this.addNodeBtn = document.getElementById('add-node-btn');
        this.newMapBtn = document.getElementById('new-map-btn');
        this.saveMapBtn = document.getElementById('save-map-btn');
        this.sidePanel = document.getElementById('side-panel');
        this.panelToggleBtn = document.getElementById('panel-toggle-btn');
        this.savedMapsList = document.getElementById('saved-maps-list');
        // Modal elements
        this.propertiesModalOverlay = document.getElementById('properties-modal-overlay');
        this.modalCloseBtn = document.getElementById('modal-close-btn');
        this.propMapName = document.getElementById('prop-map-name');
        this.propMapCreated = document.getElementById('prop-map-created');
        this.propMapModified = document.getElementById('prop-map-modified');


        // State Management
        this.nodes = {};
        this.selectedNodeId = null;
        this.scale = 1;
        this.pan = { x: 0, y: 0 };
        this.currentMapId = null;
        this.db = new MindMapDB();

        this.dragState = { isDraggingNode: false, nodeId: null, lastMousePos: { x: 0, y: 0 } };
        this.panState = { isPanning: false, lastMousePos: { x: 0, y: 0 } };
        
        // Auto-save state
        this.autoSaveTimer = null;
        this.isDirty = false;

        this.init();
    }

    async init() {
        await this.db.open();
        this.bindEventListeners();
        await this.createNewMap();
        await this.renderSavedMapsList();
        this.updateTransform();
    }

    // --- Core Node Management ---

    createNode(text, parentId, position) {
        const id = parentId === null ? ROOT_NODE_ID : `node_${Date.now()}_${Math.random()}`;
        this.nodes[id] = { id, text, parentId, childrenIds: [], position, element: null, isCollapsed: false };
        const nodeEl = this.renderNodeDOM(id, text, position);
        this.nodes[id].element = nodeEl;
        if (parentId && this.nodes[parentId]) {
            this.nodes[parentId].childrenIds.push(id);
        }
        return id;
    }

    programmaticAddNode(parentId, text) {
        if (!parentId || !this.nodes[parentId]) return null;
        const parentNode = this.nodes[parentId];
        
        const offsetX = 250;
        const baseOffsetY = 80;
        const siblingOffsetY = 120;
        let newPosition;

        if (parentNode.id === ROOT_NODE_ID) {
            const childrenOnLeft = parentNode.childrenIds.filter(id => this.nodes[id].position.x < parentNode.position.x).length;
            const childrenOnRight = parentNode.childrenIds.filter(id => this.nodes[id].position.x > parentNode.position.x).length;
            const addOnLeft = childrenOnLeft <= childrenOnRight;
            const direction = addOnLeft ? -1 : 1;
            const countOnSide = addOnLeft ? childrenOnLeft : childrenOnRight;
            const offsetY = (countOnSide % 2 === 0 ? 1 : -1) * (Math.floor(countOnSide / 2) * siblingOffsetY + baseOffsetY);
            newPosition = { x: parentNode.position.x + (direction * offsetX), y: parentNode.position.y + offsetY };
        } else {
            const rootNode = this.nodes[ROOT_NODE_ID];
            const direction = (parentNode.position.x < rootNode.position.x) ? -1 : 1;
            const childCount = parentNode.childrenIds.length;
            const offsetY = (childCount % 2 === 0 ? 1 : -1) * (Math.floor(childCount / 2) * siblingOffsetY + baseOffsetY);
            newPosition = { x: parentNode.position.x + (direction * offsetX), y: parentNode.position.y + offsetY };
        }
        return this.createNode(text, parentId, newPosition);
    }
    
    addNodeForSelected() {
        if (!this.selectedNodeId) return;
        const newNodeId = this.programmaticAddNode(this.selectedNodeId, 'شاخه جدید');
        if(newNodeId) {
            this.selectNode(newNodeId);
            this.updateUIVisibilityAndConnectors();
            this.makeNodeEditable(newNodeId);
            this.triggerAutoSave();
        }
    }

    deleteNode(nodeId) {
        if (!nodeId || nodeId === ROOT_NODE_ID) return;
        const allIdsToDelete = [nodeId, ...this.getAllDescendantIds(nodeId)];
        const nodeToDelete = this.nodes[nodeId];

        allIdsToDelete.forEach(id => {
            const node = this.nodes[id];
            if (node && node.element) node.element.remove();
            delete this.nodes[id];
        });

        if (nodeToDelete.parentId && this.nodes[nodeToDelete.parentId]) {
            const parent = this.nodes[nodeToDelete.parentId];
            parent.childrenIds = parent.childrenIds.filter(childId => childId !== nodeId);
        }

        if (allIdsToDelete.includes(this.selectedNodeId)) {
            this.selectNode(nodeToDelete.parentId || null);
        }
        this.updateUIVisibilityAndConnectors();
        this.triggerAutoSave();
    }
    
    // --- Map Data Management (DB, Markdown) ---
    
    triggerAutoSave() {
        clearTimeout(this.autoSaveTimer);
        this.isDirty = true;
        if (this.saveMapBtn.textContent === 'ذخیره شد') {
            this.saveMapBtn.textContent = 'ذخیره';
        }
        this.autoSaveTimer = setTimeout(async () => {
            await this.saveCurrentMap();
        }, 2500);
    }

    async saveCurrentMap() {
        clearTimeout(this.autoSaveTimer);
        if (!this.nodes[ROOT_NODE_ID]) return;

        this.saveMapBtn.textContent = 'در حال ذخیره...';
        this.saveMapBtn.disabled = true;

        const markdown = this.exportToMarkdown();
        const mapName = this.nodes[ROOT_NODE_ID].text;

        let mapData;
        if (this.currentMapId) {
            const existingMap = await this.db.get(this.currentMapId);
            mapData = {
                ...existingMap, // Preserve createdAt
                id: this.currentMapId,
                name: mapName,
                markdown,
                modifiedAt: new Date()
            };
            await this.db.put(mapData);
        } else {
            const id = Date.now();
            mapData = {
                id,
                name: mapName,
                markdown,
                createdAt: new Date(), // Set createdAt on creation
                modifiedAt: new Date()
            };
            const newId = await this.db.add(mapData);
            this.currentMapId = newId;
        }
        
        console.log(`Map '${mapName}' saved successfully.`);
        this.isDirty = false;
        
        this.saveMapBtn.textContent = 'ذخیره شد';
        this.saveMapBtn.disabled = false;
        
        await this.renderSavedMapsList();

        setTimeout(() => {
            if (!this.isDirty) {
                this.saveMapBtn.textContent = 'ذخیره';
            }
        }, 2000);
    }

    async loadMap(mapId) {
        clearTimeout(this.autoSaveTimer);
        this.isDirty = false;
        const map = await this.db.get(mapId);
        if (!map) return;
        this.clearCanvas();
        this.importFromMarkdown(map.markdown);
        this.currentMapId = map.id;
        this.updateUIVisibilityAndConnectors();
        this.selectNode(ROOT_NODE_ID);
        await this.renderSavedMapsList();
        if(this.sidePanel.classList.contains('open')) {
            this.panelToggleBtn.click();
        }
        this.saveMapBtn.textContent = 'ذخیره';
        this.saveMapBtn.disabled = false;
    }
    
    async deleteMap(mapId) {
        const map = await this.db.get(mapId);
        if(!map) return;
        if (!confirm(`آیا از حذف نقشه "${map.name}" مطمئن هستید؟`)) return;

        await this.db.delete(mapId);
        if (this.currentMapId === mapId) {
            await this.createNewMap();
        }
        await this.renderSavedMapsList();
    }
    
    async renameMap(mapId) {
        const map = await this.db.get(mapId);
        if(!map) return;
        const newName = prompt("نام جدید نقشه را وارد کنید:", map.name);
        if (newName && newName.trim() !== '') {
            map.name = newName.trim();
            map.modifiedAt = new Date();
            if(map.id === this.currentMapId) {
                // This will trigger an auto-save for the current map
                this.updateNodeText(ROOT_NODE_ID, newName);
            } else {
                // If it's not the current map, we need to update its markdown manually
                map.markdown = this.exportToMarkdownFromData(map.markdown, newName);
                await this.db.put(map);
            }
            await this.renderSavedMapsList();
        }
    }
    
    async downloadMap(mapId) {
        const map = await this.db.get(mapId);
        if (!map) return;
        const blob = new Blob([map.markdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${map.name.replace(/ /g, '_')}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    exportToMarkdown() {
        const buildMarkdownRecursive = (nodeId, depth) => {
            const node = this.nodes[nodeId];
            if (!node) return '';
            const indent = '  '.repeat(depth);
            let result = `${indent}- ${node.text}\n`;
            node.childrenIds.forEach(childId => {
                result += buildMarkdownRecursive(childId, depth + 1);
            });
            return result;
        };
        return buildMarkdownRecursive(ROOT_NODE_ID, 0);
    }
    
    exportToMarkdownFromData(markdown, newRootText) {
        const lines = markdown.split('\n');
        lines[0] = `- ${newRootText}`;
        return lines.join('\n');
    }

    importFromMarkdown(markdown) {
        const lines = markdown.split('\n').filter(line => line.trim() !== '');
        if (lines.length === 0) {
            this.createRootNode('موضوع اصلی');
            return;
        }

        const parentStack = [];
        const levelStack = [];

        lines.forEach((line, index) => {
            const indent = line.match(/^\s*/)[0];
            const level = indent.length / 2;
            const text = line.trim().substring(2);

            if (level === 0) {
                const rootId = this.createRootNode(text);
                parentStack.push(rootId);
                levelStack.push(level);
            } else {
                while (level <= levelStack[levelStack.length - 1] && levelStack.length > 0) {
                    parentStack.pop();
                    levelStack.pop();
                }
                const parentId = parentStack[parentStack.length - 1];
                const newNodeId = this.programmaticAddNode(parentId, text);
                if(newNodeId) {
                    parentStack.push(newNodeId);
                    levelStack.push(level);
                }
            }
        });
    }

    async createNewMap() {
        clearTimeout(this.autoSaveTimer);
        this.isDirty = false;
        this.clearCanvas();
        this.currentMapId = null;
        this.createRootNode('موضوع اصلی');
        this.updateUIVisibilityAndConnectors();
        this.selectNode(ROOT_NODE_ID);
        this.updateAddNodeButton();
        this.saveMapBtn.textContent = 'ذخیره';
        this.saveMapBtn.disabled = false;
        await this.renderSavedMapsList();
    }
    
    createRootNode(text) {
        this.clearCanvas();
        const rootNodeId = this.createNode(text, null, { x: window.innerWidth / 2, y: window.innerHeight / 2 });
        this.selectNode(rootNodeId);
        return rootNodeId;
    }
    
    clearCanvas() {
        this.nodes = {};
        this.nodesLayer.innerHTML = '';
        this.svgLayer.innerHTML = '';
        this.selectedNodeId = null;
    }

    // --- UI and Rendering ---

    async renderSavedMapsList() {
        const maps = await this.db.getAll();
        this.savedMapsList.innerHTML = '';
        if (maps.length === 0) {
            this.savedMapsList.innerHTML = `<li class="no-maps" style="padding: 1rem;">هیچ نقشه‌ای ذخیره نشده است.</li>`;
            return;
        }
        maps.forEach(map => {
            const li = document.createElement('li');
            li.dataset.mapId = map.id;
            if (map.id === this.currentMapId) {
                li.classList.add('active');
            }
            
            li.innerHTML = `
                <div class="map-info">
                    <span class="map-name">${map.name}</span>
                </div>
                <div class="map-menu-container">
                    <button class="menu-toggle-btn" aria-label="منوی گزینه‌ها">⋮</button>
                    <div class="map-item-menu">
                        <button class="properties-btn">ویژگی‌ها</button>
                        <button class="rename-btn">تغییر نام</button>
                        <button class="download-btn">دانلود</button>
                        <button class="delete-btn">حذف</button>
                    </div>
                </div>
            `;
            
            li.querySelector('.map-info').addEventListener('click', () => this.loadMap(map.id));
            
            const menuToggle = li.querySelector('.menu-toggle-btn');
            const menu = li.querySelector('.map-item-menu');
            
            menuToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.map-item-menu.open').forEach(openMenu => {
                    if (openMenu !== menu) openMenu.classList.remove('open');
                });
                menu.classList.toggle('open');
            });
            
            menu.querySelector('.properties-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.remove('open'); this.showMapProperties(map.id); });
            menu.querySelector('.rename-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.remove('open'); this.renameMap(map.id); });
            menu.querySelector('.download-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.remove('open'); this.downloadMap(map.id); });
            menu.querySelector('.delete-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.remove('open'); this.deleteMap(map.id); });
            
            this.savedMapsList.appendChild(li);
        });
    }

    async showMapProperties(mapId) {
        const map = await this.db.get(mapId);
        if (!map) return;

        this.propMapName.textContent = map.name;
        this.propMapCreated.textContent = new Date(map.createdAt || map.modifiedAt).toLocaleString('fa-IR');
        this.propMapModified.textContent = new Date(map.modifiedAt).toLocaleString('fa-IR');

        this.propertiesModalOverlay.style.display = 'flex';
    }

    hideMapProperties() {
        this.propertiesModalOverlay.style.display = 'none';
    }
    
    renderNodeDOM(nodeId, text, position) {
        const nodeEl = document.createElement('div');
        nodeEl.id = `node-${nodeId}`;
        nodeEl.className = 'mindmap-node';
        nodeEl.style.left = `${position.x}px`;
        nodeEl.style.top = `${position.y}px`;

        const textSpan = document.createElement('span');
        textSpan.className = 'node-text';
        textSpan.textContent = text;
        nodeEl.appendChild(textSpan);

        nodeEl.addEventListener('mousedown', (e) => { e.stopPropagation(); this.handleDragStart(e, nodeId); });
        nodeEl.addEventListener('dblclick', (e) => { e.stopPropagation(); this.makeNodeEditable(nodeId); });
        nodeEl.addEventListener('click', (e) => { e.stopPropagation(); this.selectNode(nodeId); });

        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'collapse-btn';
        collapseBtn.setAttribute('aria-label', 'جمع/باز کردن گره');
        collapseBtn.style.display = 'none'; // Initially hidden
        collapseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleCollapse(nodeId);
        });
        nodeEl.appendChild(collapseBtn);

        this.nodesLayer.appendChild(nodeEl);
        return nodeEl;
    }
    
    updateNodeText(nodeId, newText) {
        const nodeData = this.nodes[nodeId];
        if (nodeData) {
            const trimmedText = newText.trim();
            if (trimmedText) {
                nodeData.text = trimmedText;
                if (nodeData.element) {
                    const textSpan = nodeData.element.querySelector('.node-text');
                    if (textSpan) {
                        textSpan.textContent = trimmedText;
                    }
                }
                if (nodeId === ROOT_NODE_ID) {
                    this.renderSavedMapsList();
                }
                this.triggerAutoSave();
            }
        }
    }
    
    makeNodeEditable(nodeId) {
        const nodeData = this.nodes[nodeId];
        const nodeEl = nodeData.element;
        const textSpan = nodeEl.querySelector('.node-text');
        
        if (nodeEl.querySelector('.node-input')) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'node-input';
        input.value = nodeData.text;

        const saveChanges = () => {
            const newText = input.value.trim() || nodeData.text;
            if (nodeEl.contains(input)) {
                nodeEl.replaceChild(textSpan, input);
            }
            this.updateNodeText(nodeId, newText);
        };
        
        input.addEventListener('blur', saveChanges);
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                e.preventDefault(); input.blur();
            } else if (e.key === 'Escape') {
                input.value = nodeData.text; input.blur();
            }
        });
        
        nodeEl.replaceChild(input, textSpan);
        input.focus();
        input.select();
    }
    
    // --- Event Listeners and Handlers ---

    bindEventListeners() {
        this.canvas.addEventListener('mousedown', this.handlePanStart.bind(this));
        document.addEventListener('mousemove', this.handleMouseMove.bind(this));
        document.addEventListener('mouseup', this.handleMouseUp.bind(this));
        this.canvas.addEventListener('wheel', this.handleWheel.bind(this));
        document.addEventListener('keydown', this.handleKeyDown.bind(this));

        // Toolbar buttons
        this.addNodeBtn.addEventListener('click', () => this.addNodeForSelected());
        this.newMapBtn.addEventListener('click', () => this.createNewMap());
        this.saveMapBtn.addEventListener('click', () => this.saveCurrentMap());

        // Side panel
        this.panelToggleBtn.addEventListener('click', () => {
            this.sidePanel.classList.toggle('open');
        });
        
        // Modal
        this.modalCloseBtn.addEventListener('click', () => this.hideMapProperties());
        this.propertiesModalOverlay.addEventListener('click', (e) => {
            if (e.target === this.propertiesModalOverlay) {
                this.hideMapProperties();
            }
        });
        
        // Close open menus when clicking elsewhere
        document.addEventListener('click', (e) => {
            const openMenu = document.querySelector('.map-item-menu.open');
            if (openMenu && !openMenu.parentElement.contains(e.target)) {
                 openMenu.classList.remove('open');
            }
        });
    }

    handleKeyDown(e) {
        if (document.activeElement.tagName === 'INPUT' || document.querySelector('#properties-modal-overlay[style*="display: flex"]')) {
            if (e.key === 'Escape') this.hideMapProperties();
            return;
        }

        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            this.saveCurrentMap();
            return;
        }

        if (!this.selectedNodeId) return;

        switch (e.key) {
            case 'Tab':
                e.preventDefault(); this.addNodeForSelected(); break;
            case 'F2':
                e.preventDefault(); this.makeNodeEditable(this.selectedNodeId); break;
            case 'Delete':
                e.preventDefault(); this.deleteNode(this.selectedNodeId); break;
        }
    }
    
    selectNode(nodeId) {
        if(nodeId && this.isAnyAncestorCollapsed(nodeId)) return;
        if (this.selectedNodeId && this.nodes[this.selectedNodeId]) {
            this.nodes[this.selectedNodeId].element.classList.remove('selected');
        }
        this.selectedNodeId = nodeId;
        if (this.selectedNodeId && this.nodes[this.selectedNodeId]) {
            this.nodes[this.selectedNodeId].element.classList.add('selected');
        }
        this.updateAddNodeButton();
    }

    updateAddNodeButton() {
        this.addNodeBtn.disabled = !this.selectedNodeId;
    }
    
    updateTransform() {
        const transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.scale})`;
        this.nodesLayer.style.transform = transform;
        this.svgLayer.style.transform = transform;
    }
    
    toggleCollapse(nodeId) {
        const node = this.nodes[nodeId];
        if (!node || node.childrenIds.length === 0) return;
        node.isCollapsed = !node.isCollapsed;
        if (node.isCollapsed) {
            const descendantIds = this.getAllDescendantIds(nodeId);
            if (descendantIds.includes(this.selectedNodeId)) {
                this.selectNode(nodeId);
            }
        }
        this.updateUIVisibilityAndConnectors();
        this.triggerAutoSave();
    }
    
    updateUIVisibilityAndConnectors() {
        this.svgLayer.innerHTML = '';
        Object.values(this.nodes).forEach(node => {
            const collapseBtn = node.element.querySelector('.collapse-btn');
            if (collapseBtn) {
                const hasVisibleChildren = node.childrenIds.some(id => this.nodes[id]);
                if (hasVisibleChildren) {
                    collapseBtn.style.display = 'flex';
                    collapseBtn.textContent = node.isCollapsed ? '+' : '−';
                    const childPositionsX = node.childrenIds.map(id => this.nodes[id].position.x);
                    const allToTheRight = childPositionsX.every(x => x > node.position.x);
                    const allToTheLeft = childPositionsX.every(x => x < node.position.x);
                    Object.assign(collapseBtn.style, { left: '', right: '', top: '', bottom: '', transform: '' });
                    if (allToTheRight) {
                        collapseBtn.style.right = '-0.75rem'; collapseBtn.style.top = '50%'; collapseBtn.style.transform = 'translateY(-50%)';
                    } else if (allToTheLeft) {
                        collapseBtn.style.left = '-0.75rem'; collapseBtn.style.top = '50%'; collapseBtn.style.transform = 'translateY(-50%)';
                    } else {
                        collapseBtn.style.left = '50%'; collapseBtn.style.bottom = '-0.75rem'; collapseBtn.style.transform = 'translateX(-50%)';
                    }
                } else {
                    collapseBtn.style.display = 'none';
                }
            }
            const isVisible = !this.isAnyAncestorCollapsed(node.id);
            node.element.style.display = isVisible ? 'flex' : 'none';
            if (isVisible && node.parentId && this.nodes[node.parentId]) {
                this.drawConnector(this.nodes[node.parentId].position, node.position);
            }
        });
    }

    drawConnector(fromPos, toPos) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', fromPos.x); line.setAttribute('y1', fromPos.y);
        line.setAttribute('x2', toPos.x); line.setAttribute('y2', toPos.y);
        line.setAttribute('class', 'connector-line');
        this.svgLayer.appendChild(line);
    }
    
    handleDragStart(e, nodeId) {
        if (e.button !== 0) return;
        this.dragState = { isDraggingNode: true, nodeId: nodeId, lastMousePos: { x: e.clientX, y: e.clientY } };
    }

    handlePanStart(e) {
        if (e.target.closest('.mindmap-node') || e.button !== 0) return;
        e.preventDefault();
        this.panState = { isPanning: true, lastMousePos: { x: e.clientX, y: e.clientY } };
        this.canvas.classList.add('panning');
    }
    
    handleMouseMove(e) {
        if (this.panState.isPanning) {
            const dx = e.clientX - this.panState.lastMousePos.x;
            const dy = e.clientY - this.panState.lastMousePos.y;
            this.pan.x += dx; this.pan.y += dy;
            this.updateTransform();
            this.panState.lastMousePos = { x: e.clientX, y: e.clientY };
        } else if (this.dragState.isDraggingNode) {
            const dx = (e.clientX - this.dragState.lastMousePos.x) / this.scale;
            const dy = (e.clientY - this.dragState.lastMousePos.y) / this.scale;
            this.moveNodeAndChildren(this.dragState.nodeId, { dx, dy });
            this.dragState.lastMousePos = { x: e.clientX, y: e.clientY };
        }
    }
    
    handleMouseUp() {
        if (this.panState.isPanning) {
            this.panState.isPanning = false; this.canvas.classList.remove('panning');
        }
        if (this.dragState.isDraggingNode) {
            this.dragState.isDraggingNode = false; 
            this.dragState.nodeId = null;
            this.triggerAutoSave();
        }
    }

    handleWheel(e) {
        e.preventDefault();
        const zoomFactor = 1.1;
        const oldScale = this.scale;
        this.scale *= (e.deltaY < 0) ? zoomFactor : 1 / zoomFactor;
        this.scale = Math.max(0.2, Math.min(this.scale, 4));
        const mousePoint = { x: e.clientX, y: e.clientY };
        const worldX = (mousePoint.x - this.pan.x) / oldScale;
        const worldY = (mousePoint.y - this.pan.y) / oldScale;
        this.pan.x = mousePoint.x - worldX * this.scale;
        this.pan.y = mousePoint.y - worldY * this.scale;
        this.updateTransform();
    }
    
    updateNodePosition(nodeId, position) {
        const node = this.nodes[nodeId];
        if (node) {
            node.position = position;
            node.element.style.left = `${position.x}px`;
            node.element.style.top = `${position.y}px`;
        }
    }

    moveNodeAndChildren(rootNodeId, delta) {
        const idsToMove = [rootNodeId, ...this.getAllDescendantIds(rootNodeId)];
        idsToMove.forEach(id => {
            const node = this.nodes[id];
            if (node) {
                const newPosition = { x: node.position.x + delta.dx, y: node.position.y + delta.dy };
                this.updateNodePosition(id, newPosition);
            }
        });
        this.updateUIVisibilityAndConnectors();
    }
    
    getAllDescendantIds(nodeId) {
        const node = this.nodes[nodeId];
        if (!node || !node.childrenIds || node.childrenIds.length === 0) return [];
        return node.childrenIds.flatMap(childId => [childId, ...this.getAllDescendantIds(childId)]);
    }

    isAnyAncestorCollapsed(nodeId) {
        let currentId = this.nodes[nodeId]?.parentId;
        while (currentId) {
            const currentNode = this.nodes[currentId];
            if (currentNode.isCollapsed) return true;
            currentId = currentNode.parentId;
        }
        return false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new MindMap('mindmap-canvas');
});