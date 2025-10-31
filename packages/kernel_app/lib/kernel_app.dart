import 'dart:async';

import 'package:channel_api/channel_api.dart';
import 'package:channel_cctv/channel_cctv.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';

import 'package:core_cache/core_cache.dart';
import 'package:core_effects/core_effects.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:infra_firestore/infra_firestore.dart';
import 'package:infra_settings/infra_settings.dart';
import 'package:infra_signed_urls/infra_signed_urls.dart';

class ServiceLocator {
  final Map<Type, dynamic> _singletons = <Type, dynamic>{};
  final Map<Type, dynamic Function()> _factories = <Type, dynamic Function()>{};

  void registerSingleton<T>(T instance) => _singletons[T] = instance;

  void registerFactory<T>(T Function() factory) => _factories[T] = factory;

  T get<T>() {
    if (_singletons.containsKey(T)) {
      return _singletons[T] as T;
    }
    final dynamic Function()? factory = _factories[T];
    if (factory != null) {
      return factory() as T;
    }
    throw StateError('Type $T not registered');
  }
}

class KernelApp extends StatefulWidget {
  const KernelApp({super.key});

  @override
  State<KernelApp> createState() => _KernelAppState();
}

class _KernelAppState extends State<KernelApp> {
  late final Future<_KernelContainer> _bootstrapFuture;

  @override
  void initState() {
    super.initState();
    AppLogger.ensureInitialised();
    _bootstrapFuture = _bootstrap();
  }

  Future<_KernelContainer> _bootstrap() async {
    WidgetsFlutterBinding.ensureInitialized();
    await Firebase.initializeApp();
    final ServiceLocator locator = ServiceLocator();

    final LocalFileCache cache = LocalFileCache();
    locator
      ..registerSingleton<CachePort>(cache)
      ..registerSingleton<EffectsEngine>(EffectsEngine())
      ..registerSingleton<SettingsPort>(const LocalSettingsAdapter())
      ..registerSingleton<PlaylistPort>(FirestorePlaylistAdapter())
      ..registerSingleton<MediaFetchPort>(SignedUrlFetcher(cachePort: cache));

    final List<ChannelPlugin> plugins = <ChannelPlugin>[ChannelCctvPlugin()];
    const String partyId = String.fromEnvironment('PARTY_ID', defaultValue: 'demo-party');

    return _KernelContainer(locator: locator, plugins: plugins, partyId: partyId);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<_KernelContainer>(
      future: _bootstrapFuture,
      builder: (BuildContext context, AsyncSnapshot<_KernelContainer> snapshot) {
        if (snapshot.hasError) {
          return MaterialApp(
            theme: ThemeData.dark(),
            home: Scaffold(body: Center(child: Text('Bootstrap error: ${snapshot.error}'))),
          );
        }
        if (!snapshot.hasData) {
          return const MaterialApp(
            home: Scaffold(body: Center(child: CircularProgressIndicator())),
          );
        }
        final _KernelContainer container = snapshot.data!;
        final ChannelPlugin plugin = container.plugins.first;
        final ChannelContext ctx = ChannelContext(
          playlistPort: container.locator.get<PlaylistPort>(),
          mediaFetchPort: container.locator.get<MediaFetchPort>(),
          cachePort: container.locator.get<CachePort>(),
          effectsEngine: container.locator.get<EffectsEngine>(),
          settingsPort: container.locator.get<SettingsPort>(),
          partyId: container.partyId,
        );
        return MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: ThemeData.dark(),
          home: Scaffold(
            backgroundColor: Colors.black,
            body: SafeArea(child: plugin.buildEntry(ctx)),
          ),
        );
      },
    );
  }
}

class _KernelContainer {
  const _KernelContainer({required this.locator, required this.plugins, required this.partyId});

  final ServiceLocator locator;
  final List<ChannelPlugin> plugins;
  final String partyId;
}
