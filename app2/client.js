var commands = require('./commands');
var commandManager = require('./commandManager')(commands);
var Q = require('./vendor/q');
var dgram = require('dgram');
var os = require('os');
var net = require('net');

// Fills an array with a particular value
var fill = function(value, length) {
    var array = []
    for (var i = 0; i < length; i++) {
        array.push(value);
    }
    return array;
};

// Function that returns the same value
var unity = function(value) { return value; };

// Client object to connect to a device
module.exports = function(options) {
    var client = {
        devices: {},
        desiredChannels: fill(1500, 12),
        actualChannels: fill(1500, 12),
        batteries: [],
        digitalInputs: []
    };

    // Ports for recieving data (largely arbitrary)
    client.localPorts = {
        discovery: 24454,
        control: 24454,
        status: 24455,
        camera: 24456
    };

    // Ports for sending signals to the device
    client.remotePorts = {
        discovery: 1984,
        config: 1984,
        control: null
    };

    // Device configuration
    client.deviceSettings = {
        deviceType: 0,
        version: [0, 1],
        priority: 0xff,
        transmitterName: 'node-wirc',
        statusPort: client.localPorts.status
    };

    // Sets filters for channels
    client.channelFilters = fill(unity, 12);
    if (options.filters) {
        for (i in options.filters) {
            if (options.filters[i]) client.channelFilters[i] = options.filters[i];
        }
    }

    // Sets up control mappings
    if (options.controls) {
        for (i in options.controls) {
            (function(control) {
                client[i] = function(input) {
                    var outputRange = control.output[1] - control.output[0];
                    var inputRange = control.input[1] - control.input[0];
                    var value = (input - control.input[0]) / inputRange * outputRange + control.output[0];
                    this.desiredChannels[control.channel] = parseInt(value);
                }
            })(options.controls[i]);
        }
    }

    client.discover = function() {
        // Sets up deferred to create a promise for the socked callback
        var deferred = Q.defer();
        var self = this;

        // Gets all IPs assigned to this machine
        var addresses = [];
        var interfaces = os.networkInterfaces();
        for (k in interfaces) {
            for (k2 in interfaces[k]) {
                var address = interfaces[k][k2];
                if (address.family == 'IPv4' && !address.internal) {
                    addresses.push(address.address);
                }
            }
        }

        // Performs broadcast discovery on each interface
        addresses.forEach(function(address) {
            // Sets up a broadcast socket
            var socket = dgram.createSocket('udp4');
            socket.bind(self.localPorts.discovery, address);
            socket.setBroadcast(true);

            // Sends the broadcast discover command
            var buffer = commandManager.encode('broadcastDiscover', self.deviceSettings);
            socket.send(buffer, 0, buffer.length, self.remotePorts.discovery, "255.255.255.255");
            socket.on('message', function(buffer, info) {
                // Recieves the command and fulfills the promise
                var response = commandManager.decode(buffer);
                response.remoteAddress = info.address;
                response.localAddress = address;
                self.devices[response.serialNumber] = response;
                deferred.resolve(response.serialNumber);
                socket.close();
            });
        })

        return deferred.promise;
    };

    client.connect = function(serialNumber) {
        // Sets up deferred to create a promise for the socked callback
        var deferred = Q.defer();
        var self = this;

        // This defines the device we are trying to connect to
        self.serialNumber = serialNumber;

        // Sets up a TCP socket
        var socket = new net.Socket();
        var device = this.chosenDevice();
        socket.connect(self.remotePorts.config, device.remoteAddress);

        // Sends all mandatory config commands
        socket.on('connect', function() {
            var buffer = commandManager.encode('transmitterLogin', self.deviceSettings);
            socket.write(buffer);

            // Time periods for servo outputs
            var buffer = commandManager.encode('channelConfig', {timePeriods: fill(15000, 12)});
            socket.write(buffer);

            // Default values for outputs when not sent a signal
            var buffer = commandManager.encode('failsafeConfig', {channelValues: fill(0, 12)});
            socket.write(buffer);
        });

        // Retrieves the response
        socket.on('data', function(buffer) {
            var response = commandManager.decode(buffer);
            if (response.command == 'loginComplete') {
                self.remotePorts.control = response.controlPort;
                deferred.resolve();
            }
        });

        return deferred.promise;
    };

    client.enable = function() {
        // Sets up deferred to create a promise for the socked callback
        var deferred = Q.defer();
        var self = this;

        // Sets up a UDP socket
        var socket = dgram.createSocket('udp4');
        var device = this.chosenDevice();
        socket.bind(self.localPorts.control);

        // Poll device with control signal
        this.controlPolling = setInterval(function() {

            self.actualChannels = self.desiredChannels.map(function(channel, i) {
                return self.channelFilters[i](channel, self.actualChannels[i]);
            });

            var buffer = commandManager.encode('controlChannels', {channelValues: self.actualChannels});
            socket.send(buffer, 0, buffer.length, self.remotePorts.control, device.remoteAddress);

        }, 15);

        deferred.resolve();
        return deferred.promise;
    };

    client.monitorStatus = function() {
        var self = this;

        // Set up socket to recieve status updates
        var socket = dgram.createSocket('udp4');
        socket.bind(self.localPorts.status);
        socket.on('message', function(buffer) {
            var response = commandManager.decode(buffer);
            self.batteries = response.batteries;
            self.digitalInputs = response.digitalInputs;
        });
    };

    client.chosenDevice = function() {
        return this.devices[this.serialNumber];
    }

    return client;
};
