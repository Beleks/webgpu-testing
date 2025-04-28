import "./style.css";
import javascriptLogo from "./javascript.svg";
import { setupCounter } from "./counter.js";

document.querySelector("#app").innerHTML = `
  <div>
    <div>webGPU</div>
    <canvas></canvas>
  </div>
`;

const canvas = document.querySelector("canvas");
const context = canvas.getContext("webgpu");
let presentationFormat = null;
let device = null;

console.log(navigator.gpu, "navigator.gpu");

async function getDevice() {
  if (!navigator.gpu) {
    throw Error("WebGPU не поддерживается.");
  }
  const adapter = await navigator.gpu?.requestAdapter();
  // const adapter = null;
  if (!adapter) {
    throw new Error("Не удалось загрузить адаптер");
  }
  // Что за объект adapter? Всегда ли у него есть метод requestDevice()
  return adapter.requestDevice();
}

getDevice()
  .then((loadedDevice) => {
    console.log(loadedDevice, "device");

    device = loadedDevice;
    presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    setContextConfig();

    const module = initModule(device);
    const pipeline = initPipeline(device, module);

    render(device, pipeline);
  })
  .catch((error) => {
    console.error(error);
  });

function initModule(device) {
  return device.createShaderModule({
    label: "Красный треугольник",
    // language=wgsl
    code: `
      @vertex fn vs(
        @builtin(vertex_index) vertexIndex : u32
      ) -> @builtin(position) vec4f {
        let pos = array(
          vec2f( 0.0,  0.5),  // top center
          vec2f(-0.5, -0.5),  // bottom left
          vec2f( 0.5, -0.5)   // bottom right
        );
 
        return vec4f(pos[vertexIndex], 1.0, 1.0);
      }
 
      @fragment fn fs() -> @location(0) vec4f {
        return vec4f(1.0, 0.0, 0.0, 1.0);
      }
    `,
  });
}

function initComputedModule(device) {
  return device.createShaderModule({
    label: "doubling compute module",
    // language=wgsl
    code: `
      @group(0) @binding(0) var<storage, read_write> data: array<f32>;
 
      @compute @workgroup_size(1) fn computeSomething(
        @builtin(global_invocation_id) id: vec3u
      ) {
        let i = id.x;
        data[i] = data[i] * 2.0;
      }
    `,
  });
}

function initPipeline(device, module) {
  return device.createRenderPipeline({
    label: "our hardcoded red triangle pipeline",
    layout: "auto",
    vertex: {
      module,
    },
    fragment: {
      module,
      // TODO: Разобраться для чего
      targets: [{ format: presentationFormat }],
    },
  });
}

function setContextConfig() {
  context.configure({
    device,
    format: presentationFormat,
  });
}

const renderPassDescriptor = {
  label: "our basic canvas renderPass",
  colorAttachments: [
    {
      // view: <- to be filled out when we render
      clearValue: [0.3, 0.3, 0.3, 1],
      loadOp: "clear",
      storeOp: "store",
    },
  ],
};

function render(device, pipeline) {
  // Получаем текстуру с контекста canvas
  renderPassDescriptor.colorAttachments[0].view = context
    .getCurrentTexture()
    .createView();

  const encoder = device.createCommandEncoder({ label: "our encoder" });

  // make a render pass encoder to encode render specific commands
  const pass = encoder.beginRenderPass(renderPassDescriptor);
  pass.setPipeline(pipeline);
  pass.draw(3); // Вызываем vertex shader 3 раза
  pass.end();

  const commandBuffer = encoder.finish();
  device.queue.submit([commandBuffer]);
}

// setupCounter(document.querySelector('#counter'))
