import 'dart:io';

import 'package:companion_app/src/media/guest_photo_picker.dart';
import 'package:companion_app/src/session/guest_media_session.dart';

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWeb;

final class GuestPhotoScreen extends StatefulWidget {
  const GuestPhotoScreen({
    super.key,
    required this.session,
    required this.picker,
  });
  final GuestMediaSession session;
  final GuestPhotoPicker picker;
  @override
  State<GuestPhotoScreen> createState() => _GuestPhotoScreenState();
}

final class _GuestPhotoScreenState extends State<GuestPhotoScreen> {
  File? photo;
  GuestPhotoBytes? browserPhoto;
  bool get hasPhoto => photo != null || browserPhoto != null;
  bool consent = false;
  String? message;
  @override
  void dispose() {
    final selected = photo;
    if (selected != null) {
      selected.exists().then((exists) {
        if (exists) selected.delete();
      });
    }
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    widget.session
        .recover()
        .then((_) {
          if (mounted) {
            setState(
              () => message = widget.session.status == null
                  ? null
                  : 'Saved submission status: ${widget.session.status}.',
            );
          }
        })
        .catchError((Object _) {
          if (mounted) {
            setState(
              () => message = 'Could not refresh saved submission status.',
            );
          }
        });
  }

  Future<void> choose() async {
    if (widget.session.busy) return;
    if (kIsWeb) {
      setState(() {
        browserPhoto = null;
        consent = false;
        message = null;
      });
      try {
        final picker = widget.picker;
        if (picker is! GuestPhotoBytesPicker) {
          throw StateError('Browser photo selection is unavailable.');
        }
        final selected = await (picker as GuestPhotoBytesPicker)
            .pickPhotoBytes();
        if (!mounted) return;
        setState(() {
          browserPhoto = selected;
          consent = false;
          message = selected == null ? 'Photo selection cancelled.' : null;
        });
      } catch (_) {
        if (mounted) {
          setState(
            () => message =
                'Could not select photo. Choose a JPEG or PNG and retry.',
          );
        }
      }
      return;
    }
    final selected = await widget.picker.pickPhoto();
    if (!mounted) {
      if (selected != null && await selected.exists()) await selected.delete();
      return;
    }
    final previous = photo;
    if (previous != null &&
        previous.path != selected?.path &&
        await previous.exists()) {
      await previous.delete();
    }
    setState(() {
      photo = selected;
      consent = false;
      message = selected == null ? 'Photo selection cancelled.' : null;
    });
  }

  Future<void> submit() async {
    final selected = photo;
    final selectedBytes = browserPhoto;
    if ((selected == null && selectedBytes == null) || !consent) return;
    final confirmed =
        await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('Confirm photo upload'),
            content: const Text(
              'Upload this photo to transform it for the party TV?',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('Upload photo'),
              ),
            ],
          ),
        ) ??
        false;
    if (!confirmed) {
      if (selected != null && await selected.exists()) await selected.delete();
      if (mounted) {
        setState(() {
          photo = null;
          browserPhoto = null;
        });
      }
      return;
    }
    setState(() => message = 'Uploading…');
    String contentType = 'image/jpeg';
    try {
      if (selectedBytes != null) {
        await widget.session.submitBytes(
          selectedBytes.bytes,
          consent: consent,
          confirmed: confirmed,
          contentType: selectedBytes.contentType,
        );
      } else if (selected != null) {
        contentType = widget.picker.contentTypeFor(selected);
        await widget.session.submit(
          selected,
          consent: consent,
          confirmed: confirmed,
          contentType: contentType,
        );
      }
      if (mounted) setState(() => message = 'Photo submitted.');
    } catch (_) {
      if (mounted) {
        setState(
          () => message =
              'Upload could not be completed. Select the photo again to retry.',
        );
      }
    } finally {
      if (selected != null && await selected.exists()) await selected.delete();
      if (mounted) {
        setState(() {
          photo = null;
          browserPhoto = null;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Guest photo')),
    body: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const Text(
          'Optional photo submission',
          style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 12),
        const Text(
          'Your photo will be transformed for Halloween and may appear on the party TV. The image is processed by our media provider and temporarily retained in cloud storage. You can delete the photo and withdraw here. A copy already downloaded to the TV may not be removable while that TV is offline.',
          style: TextStyle(fontSize: 17),
        ),
        const SizedBox(height: 16),
        OutlinedButton(
          onPressed: widget.session.busy ? null : choose,
          child: const Text('Choose photo'),
        ),
        if (photo != null) Image.file(photo!, height: 220, fit: BoxFit.contain),
        if (browserPhoto != null)
          Image.memory(browserPhoto!.bytes, height: 220, fit: BoxFit.contain),
        CheckboxListTile(
          value: consent,
          onChanged: !hasPhoto
              ? null
              : (v) => setState(() => consent = v ?? false),
          title: const Text(
            'I understand and affirmatively consent to this photo being processed and shown on the party TV.',
          ),
        ),
        FilledButton(
          onPressed: !hasPhoto || !consent || widget.session.busy
              ? null
              : submit,
          child: const Text('Review and upload'),
        ),
        if (widget.session.submissionIds.isNotEmpty)
          for (final String id in widget.session.submissionIds)
            OutlinedButton(
              onPressed: widget.session.busy
                  ? null
                  : () async {
                      await widget.session.withdraw(submissionId: id);
                      if (mounted) {
                        setState(
                          () => message =
                              widget.session.submissionIds.contains(id)
                              ? 'Cloud deletion is pending. Retry when online.'
                              : 'Withdrawal recorded and deletion confirmed.',
                        );
                      }
                    },
              child: const Text('Delete photo and withdraw'),
            ),
        if (widget.session.statuses.values.any(
          (s) => s == 'deletionPending' || s == 'recorded',
        ))
          OutlinedButton(
            onPressed: () => widget.session.retryWithdrawal(),
            child: const Text('Retry deletion'),
          ),
        if (message != null)
          Text(message!, key: const Key('guest-photo-status')),
      ],
    ),
  );
}
