require('dotenv').config();
require('@google-cloud/debug-agent').start();
const express = require('express');
const DatabaseAPI = require('./datasources/database');
const ConjugationAPI = require('./datasources/conjugation');
const SearchAPI = require('./datasources/search');
const resolvers = require('./resolvers');

const { ApolloServer } = require('apollo-server-express');
const typeDefs = require('./schema');
let dbAPI = new DatabaseAPI();
const server = new ApolloServer({
    typeDefs,
    resolvers,
    dataSources: () => ({
        databaseAPI: dbAPI,
        conjugationAPI: new ConjugationAPI(),
        searchAPI: new SearchAPI(dbAPI)
    })
});

// Required for min_instances
const app = express();
server.applyMiddleware({ app });
app.get('/_ah/warmup', (req, res) => {
   res.send('All warmed up!');
});

app.get('/uptime', (req, res) => {
   res.send('Still up!')
});

const PORT = process.env.PORT || 4000;
app.listen({ port: PORT },(url) => {
   console.log('Server ready at '+url)
});

// Implement String.format. First, check if it isn't implemented already.
if (!String.prototype.format) {
    String.prototype.format = function() {
        var args = arguments;
        return this.replace(/{(\d+)}/g, function(match, number) {
            return typeof args[number] != 'undefined'
                ? args[number]
                : match
                ;
        });
    };
}