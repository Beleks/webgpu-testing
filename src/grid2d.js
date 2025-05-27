async function initGrid2d() {
  // Инициализация WebGPU
  const canvas = document.querySelector("canvas");
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");

  // Настройка формата и размера канваса
  const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device: device,
    format: presentationFormat,
    alphaMode: 'opaque'
  });

  // --- Шейдеры (WGSL) ---
  const shaderModule = device.createShaderModule({
    //language=wgsl
    code: `
      struct Uniforms {
          // Поля упорядочены для избежания неожиданного заполнения (padding)
          // и соответствия размеру 40 байт
          line_color: vec4<f32>,        // смещение 0, размер 16
          scale_factor_xy: vec2<f32>,   // смещение 16, размер 8 (масштаб ячейки в пикселях)
          grid_origin_pixels_xy: vec2<f32>, // смещение 24, размер 8 (положение (0,0) сетки в пикселях холста)
          viewport_size_xy: vec2<f32>   // смещение 32, размер 8 (размеры холста)
          // Общий размер: 16 + 8 + 8 + 8 = 40 байт
      }

      @group(0) @binding(0) var<uniform> uniforms: Uniforms;

      struct VertexOutput {
          @builtin(position) position: vec4<f32>,
      };

      @vertex
      fn vs_main(@location(0) logical_pos: vec2<f32>) -> VertexOutput {
          var out: VertexOutput;

          // 1. Преобразование из логических координат сетки в пиксельные координаты на холсте
          let pixel_pos = logical_pos * uniforms.scale_factor_xy + uniforms.grid_origin_pixels_xy;

          // 2. Преобразование из пиксельных координат холста в нормализованные координаты устройства (NDC)
          // NDC X: -1 (слева) до +1 (справа)
          // NDC Y: -1 (снизу) до +1 (сверху)
          let ndc_x = (pixel_pos.x / uniforms.viewport_size_xy.x) * 2.0 - 1.0;
          let ndc_y = (1.0 - (pixel_pos.y / uniforms.viewport_size_xy.y)) * 2.0; // Y инвертируется, т.к. (0,0) холста вверху слева

          out.position = vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);
          return out;
      }

      @fragment
      fn fs_main() -> @location(0) vec4<f32> {
          return uniforms.line_color;
      }
    `
  });

  // --- Конвейер рендеринга ---
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vs_main',
      buffers: [{ // Описание одного буфера вершин
        arrayStride: 2 * 4, // 2 компонента float32 (x, y) = 8 байт
        attributes: [{
          shaderLocation: 0, // соответствует @location(0) в vs_main
          offset: 0,
          format: 'float32x2'
        }]
      }]
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [{
        format: presentationFormat
      }]
    },
    primitive: {
      topology: 'line-list' // Рисуем список линий
    }
  });

  // --- Uniform-буфер ---
  // Размер соответствует структуре Uniforms в шейдере (40 байт)
  const uniformBufferSize = (4 + 2 + 2 + 2) * 4; // 10 float * 4 байта/float = 40 байт
  const uniformBuffer = device.createBuffer({
    size: uniformBufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  // --- Bind Group ---
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0), // Получаем layout из конвейера
    entries: [{
      binding: 0, // соответствует @group(0) @binding(0)
      resource: {
        buffer: uniformBuffer
      }
    }]
  });

  // --- Параметры сетки и управления ---
  const baseCellSize = 50.0; // Базовый логический размер ячейки
  let currentZoom = 1.0;
  let panOffset = { x: 0.0, y: 0.0 }; // Смещение панорамирования в пикселях

  const majorLineColor = [0.5, 0.5, 0.5, 1.0]; // Серый для основных линий
  const minorLineColor = [0.3, 0.3, 0.3, 1.0]; // Темно-серый для второстепенных
  const sectionInterval = 5; // Каждая 5-я линия - основная

  let majorLineVertices = [];
  let minorLineVertices = [];
  let majorVertexBuffer, minorVertexBuffer;

  function generateGridVertices() {
    majorLineVertices = [];
    minorLineVertices = [];

    const effectiveCellSize = baseCellSize * currentZoom;
    if (effectiveCellSize < 2) return; // Слишком мелкая сетка, не генерируем

    // Рассчитываем видимый диапазон логических координат
    // grid_origin_pixels_xy - это где на холсте будет логическая точка (0,0) сетки.
    // Начальное положение grid_origin (до панорамирования) - центр холста.
    const initialGridOriginX = canvas.width / 2;
    const initialGridOriginY = canvas.height / 2;

    const viewMinLogicalX = (- (initialGridOriginX + panOffset.x)) / effectiveCellSize - 5; // c запасом
    const viewMaxLogicalX = (canvas.width - (initialGridOriginX + panOffset.x)) / effectiveCellSize + 5;
    const viewMinLogicalY = (- (initialGridOriginY + panOffset.y)) / effectiveCellSize - 5;
    const viewMaxLogicalY = (canvas.height - (initialGridOriginY + panOffset.y)) / effectiveCellSize + 5;


    // Вертикальные линии (логические X координаты)
    for (let lx = Math.floor(viewMinLogicalX); lx <= Math.ceil(viewMaxLogicalX); lx++) {
      const lineEndpoints = [
        lx, viewMinLogicalY - 5, // выход за пределы для красоты
        lx, viewMaxLogicalY + 5,
      ];
      if (lx % sectionInterval === 0) {
        majorLineVertices.push(...lineEndpoints);
      } else {
        minorLineVertices.push(...lineEndpoints);
      }
    }

    // Горизонтальные линии (логические Y координаты)
    for (let ly = Math.floor(viewMinLogicalY); ly <= Math.ceil(viewMaxLogicalY); ly++) {
      const lineEndpoints = [
        viewMinLogicalX - 5, ly,
        viewMaxLogicalX + 5, ly,
      ];
      if (ly % sectionInterval === 0) {
        majorLineVertices.push(...lineEndpoints);
      } else {
        minorLineVertices.push(...lineEndpoints);
      }
    }
  }


  function updateVertexBuffers() {
    generateGridVertices();

    // Уничтожаем старые буферы, если они существуют
    if (majorVertexBuffer) majorVertexBuffer.destroy();
    if (minorVertexBuffer) minorVertexBuffer.destroy();

    majorVertexBuffer = device.createBuffer({
      size: Math.max(16, majorLineVertices.length * 4), // float32 занимает 4 байта
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: false // Данные будут загружены через writeBuffer
    });
    if (majorLineVertices.length > 0) {
      device.queue.writeBuffer(majorVertexBuffer, 0, new Float32Array(majorLineVertices));
    }


    minorVertexBuffer = device.createBuffer({
      size: Math.max(16, minorLineVertices.length * 4),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: false
    });
    if (minorLineVertices.length > 0) {
      device.queue.writeBuffer(minorVertexBuffer, 0, new Float32Array(minorLineVertices));
    }
  }

  updateVertexBuffers(); // Первоначальная генерация

  // --- Интерактивность ---
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const zoomIntensity = 0.1;
    const scroll = event.deltaY < 0 ? 1 : -1;
    const zoomFactor = 1 + scroll * zoomIntensity;

    const oldZoom = currentZoom;
    currentZoom *= zoomFactor;
    currentZoom = Math.max(0.05, Math.min(currentZoom, 20.0)); // Ограничение масштаба

    // Масштабирование относительно курсора
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left; // Координаты мыши относительно холста
    const mouseY = event.clientY - rect.top;

    // Логические координаты точки под курсором до масштабирования
    // scale_factor_xy = baseCellSize * oldZoom
    // grid_origin_pixels_xy = canvas_center + panOffset
    // pixel_pos = logical_pos * scale_factor_xy + grid_origin_pixels_xy
    // logical_pos = (pixel_pos - grid_origin_pixels_xy) / scale_factor_xy
    const logicalMouseX = (mouseX - (canvas.width / 2 + panOffset.x)) / (baseCellSize * oldZoom);
    const logicalMouseY = (mouseY - (canvas.height / 2 + panOffset.y)) / (baseCellSize * oldZoom);

    // Новое смещение панорамирования, чтобы логическая точка осталась под курсором
    // panOffset.x = mouseX - canvas.width/2 - logicalMouseX * (baseCellSize * currentZoom)
    panOffset.x = mouseX - canvas.width / 2 - logicalMouseX * (baseCellSize * currentZoom);
    panOffset.y = mouseY - canvas.height / 2 - logicalMouseY * (baseCellSize * currentZoom);


    updateVertexBuffers();
  });

  let isPanning = false;
  let lastMousePos = { x: 0, y: 0 };
  canvas.addEventListener('mousedown', (event) => {
    if (event.button === 0) { // Только ЛКМ
      isPanning = true;
      lastMousePos = { x: event.clientX, y: event.clientY };
    }
  });
  canvas.addEventListener('mousemove', (event) => {
    if (isPanning) {
      const dx = event.clientX - lastMousePos.x;
      const dy = event.clientY - lastMousePos.y;
      panOffset.x += dx;
      panOffset.y += dy;
      lastMousePos = { x: event.clientX, y: event.clientY };
      updateVertexBuffers();
    }
  });
  canvas.addEventListener('mouseup', () => { isPanning = false; });
  canvas.addEventListener('mouseleave', () => { isPanning = false; });


  // --- Цикл рендеринга ---
  function frame() {
    if (!canvas) return; // Если холст удален

    const effectiveCellSize = baseCellSize * currentZoom;

    // Данные для uniform-буфера
    // Порядок должен точно соответствовать структуре Uniforms в шейдере!
    const uniformValues = new Float32Array([
      // line_color (будет перезаписан для каждого типа линий)
      0, 0, 0, 0, // Временный цвет, будет перезаписан ниже
      // scale_factor_xy
      effectiveCellSize, effectiveCellSize,
      // grid_origin_pixels_xy (центр холста + смещение панорамирования)
      canvas.width / 2 + panOffset.x, canvas.height / 2 + panOffset.y,
      // viewport_size_xy
      canvas.width, canvas.height
    ]);


    const commandEncoder = device.createCommandEncoder();
    const textureView = context.getCurrentTexture().createView();

    const renderPassDescriptor = {
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.1, g: 0.1, b: 0.12, a: 1.0 }, // Цвет фона
        loadOp: 'clear',
        storeOp: 'store'
      }]
    };
    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);

    // Рисуем второстепенные линии
    if (minorLineVertices.length > 0) {
      uniformValues.set(minorLineColor, 0); // Устанавливаем цвет для второстепенных линий в начало Float32Array
      device.queue.writeBuffer(uniformBuffer, 0, uniformValues);
      passEncoder.setVertexBuffer(0, minorVertexBuffer);
      passEncoder.draw(minorLineVertices.length / 2, 1, 0, 0); // Делим на 2, т.к. 2 float (x,y) на вершину
    }

    // Рисуем основные линии
    if (majorLineVertices.length > 0) {
      uniformValues.set(majorLineColor, 0); // Устанавливаем цвет для основных линий
      device.queue.writeBuffer(uniformBuffer, 0, uniformValues);
      passEncoder.setVertexBuffer(0, majorVertexBuffer);
      passEncoder.draw(majorLineVertices.length / 2, 1, 0, 0);
    }

    passEncoder.end();
    device.queue.submit([commandEncoder.finish()]);

    requestAnimationFrame(frame);
  }

  // Обработка изменения размера окна
  const resizeObserver = new ResizeObserver(entries => {
    for (const entry of entries) { // Обычно одна запись
      const newWidth = Math.max(1, Math.floor(entry.contentBoxSize[0].inlineSize));
      const newHeight = Math.max(1, Math.floor(entry.contentBoxSize[0].blockSize));

      if (canvas.width !== newWidth || canvas.height !== newHeight) {
        canvas.width = newWidth;
        canvas.height = newHeight;

        // Важно: переконфигурировать контекст при изменении размера холста
        context.configure({
          device: device,
          format: presentationFormat,
          alphaMode: 'opaque'
        });
        updateVertexBuffers(); // Перегенерировать вершины для нового размера
      }
    }
  });

  try {
    resizeObserver.observe(canvas);
  } catch(e) {
    console.error("ResizeObserver не поддерживается или произошла ошибка:", e);
    // Можно добавить простой window.onresize как fallback, но он менее производителен
  }


  requestAnimationFrame(frame); // Запуск цикла рендеринга
}

export default initGrid2d;
