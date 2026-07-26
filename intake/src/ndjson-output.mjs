function closedOutputError() {
  return new Error("output stream closed before drain");
}

function waitForDrain(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const settle = (callback, value) => {
      cleanup();
      callback(value);
    };
    const onDrain = () => settle(resolve);
    const onError = (error) => settle(reject, error);
    const onClose = () => settle(reject, closedOutputError());

    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
    if (stream.destroyed || stream.closed || stream.writableEnded) onClose();
  });
}

export async function writeJsonLine(stream, value) {
  if (stream.destroyed || stream.closed || stream.writableEnded) {
    throw closedOutputError();
  }
  if (!stream.write(`${JSON.stringify(value)}\n`)) {
    await waitForDrain(stream);
  }
}
