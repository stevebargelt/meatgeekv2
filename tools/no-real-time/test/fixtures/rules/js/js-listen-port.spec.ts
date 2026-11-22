it('binds a fixed port', async () => {
  server.listen(4300); // expect: js-listen-port
  app.listen(8_080, '127.0.0.1', ready); // expect: js-listen-port
  other.listen({ port: 9229, host: '127.0.0.1' }); // expect: js-listen-port
  // Port 0 asks the OS for a free one: not a hit.
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  free.listen({ port: 0 });
  socket.listen(path); // a socket path or variable: not this rule's business
});
