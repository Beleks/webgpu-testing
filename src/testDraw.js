async function initWebGPU() {
  // Проверка поддержки WebGPU
  if (!navigator.gpu) throw new Error("WebGPU не поддерживается в вашем браузере");

  // Получение адаптера и устройства
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();

  // Получение контекста canvas
  const canvas = document.getElementById('canvas');
  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();

  // Конфигурация контекста
  context.configure({
    device: device,
    format: format,
    alphaMode: 'opaque'
  });

  return { device, canvas, format, context };
}

async function main() {
  const { device, context, format } = await initWebGPU();
  const { vertexBuffer, uniformBuffer, vertexCount } = createGridBuffers(device);
  const pipeline = createPipeline(device, format);
  renderGrid(device, context, pipeline, vertexBuffer, uniformBuffer, vertexCount);

  // Обработка изменения размера окна
  window.addEventListener('resize', () => {
    renderGrid(device, context, pipeline, vertexBuffer, uniformBuffer, vertexCount);
  });
}

function createGridBuffers(device, gridSize = 10, cellSize = 1) {
  // Вычисляем количество линий (gridSize x gridSize)
  const lineCount = (gridSize + 1) * 2; // Горизонтальные + вертикальные линии
  const vertexCount = lineCount * 2;     // Каждая линия имеет 2 точки

  // Создаем массив вершин (x, y, z)
  const vertices = new Float32Array(vertexCount * 3);

  let offset = 0;
  const halfSize = gridSize * cellSize / 2;

  // Вертикальные линии
  for (let i = 0; i <= gridSize; i++) {
    const x = i * cellSize - halfSize;
    vertices[offset++] = x;
    vertices[offset++] = -halfSize;
    vertices[offset++] = 0;

    vertices[offset++] = x;
    vertices[offset++] = halfSize;
    vertices[offset++] = 0;
  }

  // Горизонтальные линии
  for (let i = 0; i <= gridSize; i++) {
    const y = i * cellSize - halfSize;
    vertices[offset++] = -halfSize;
    vertices[offset++] = y;
    vertices[offset++] = 0;

    vertices[offset++] = halfSize;
    vertices[offset++] = y;
    vertices[offset++] = 0;
  }

  // Создаем GPU-буфер для вершин
  const vertexBuffer = device.createBuffer({
    size: vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
  vertexBuffer.unmap();

  // Uniform-буфер для матрицы проекции
  const uniformBuffer = device.createBuffer({
    size: 16 * 4, // mat4x4 (16 чисел по 4 байта)
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  return { vertexBuffer, uniformBuffer, vertexCount };
}

function renderGrid(device, context, pipeline, vertexBuffer, uniformBuffer, vertexCount) {
  // 1. Обновляем размеры canvas
  const canvas = context.canvas;
  const displayWidth = canvas.clientWidth;
  const displayHeight = canvas.clientHeight;

  if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
    canvas.width = displayWidth;
    canvas.height = displayHeight;
  }

  // 2. Создаем ортографическую матрицу вручную (без gl-matrix)
  const left = -canvas.width / 2;
  const right = canvas.width / 2;
  const bottom = -canvas.height / 2;
  const top = canvas.height / 2;
  const near = -1;
  const far = 1;

  // Ортографическая матрица 4x4 (column-major)
  const projectionMatrix = new Float32Array([
    2 / (right - left), 0, 0, 0,
    0, 2 / (top - bottom), 0, 0,
    0, 0, 2 / (far - near), 0,
    -(right + left) / (right - left), -(top + bottom) / (top - bottom), -(far + near) / (far - near), 1
  ]);

  // 3. Копируем матрицу в буфер
  device.queue.writeBuffer(
    uniformBuffer,
    0,
    projectionMatrix.buffer
  );

  // 4. Начинаем рендер-пасс
  const commandEncoder = device.createCommandEncoder();
  const renderPass = commandEncoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      loadOp: 'clear',
      clearValue: { r: 1, g: 1, b: 1, a: 1 },
      storeOp: 'store'
    }]
  });

  // 5. Устанавливаем конвейер и ресурсы
  renderPass.setPipeline(pipeline);
  renderPass.setVertexBuffer(0, vertexBuffer);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
  });
  renderPass.setBindGroup(0, bindGroup);

  // 6. Рисуем сетку
  renderPass.draw(vertexCount);
  renderPass.end();

  // 7. Отправляем команды
  device.queue.submit([commandEncoder.finish()]);
}

function createPipeline(device, format) {
  const shaderModule = device.createShaderModule({
    //language=wgsl
    code: `
      struct VertexInput {
        @location(0) position: vec3f,
      };
      
      struct Uniforms {
        mvp: mat4x4f,
      };
      
      @group(0) @binding(0) var<uniform> uniforms: Uniforms;
      
      struct VertexOutput {
        @builtin(position) position: vec4f,
      };
      
      @vertex
      fn vs_main(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        output.position = uniforms.mvp * vec4f(input.position, 1.0);
        return output;
      }
      
      // Фрагментный шейдер
      @fragment
      fn fs_main() -> @location(0) vec4f {
        return vec4f(0.5, 0.5, 0.5, 1.0); // Серый цвет линий
      }
    `
  });

  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vs_main',
      buffers: [{
        arrayStride: 3 * 4, // 3 float32 (x, y, z)
        attributes: [{
          shaderLocation: 0,
          offset: 0,
          format: 'float32x3'
        }]
      }]
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [{ format: format }]
    },
    primitive: {
      topology: 'line-list' // Режим отрисовки линий
    }
  });

  return pipeline;
}

main();